## Goal

Step 1 of `docs/ROADMAP.md`: make `hive` installable from a release and updatable.

- `scripts/build-release.sh` builds a signed release: an app bundle with Node, the CLI as one
  bundled file and the VM launcher, plus a separate VM rootfs download.
- `install-cli.sh` installs the latest release.
- New commands: `hive setup` (fetches the rootfs), `hive doctor` (shows what's available),
  `hive update` (`--check`, `--rollback`) that verifies a signature and checksums and switches
  versions atomically, and a once-a-day "new version available" notice.
- libkrun and pasta still come from the system in this step.

## Files to touch

- `src/release.ts` (new)
- `src/release-key.ts` (new)
- `src/cli.ts`
- `scripts/build-release.sh` (new)
- `scripts/keygen.mjs` (new)
- `scripts/sign.mjs` (new)
- `install-cli.sh` (new)
- `package.json`, `package-lock.json`
- `.gitignore`
- `README.md`
- `docs/RELEASING.md` (new)
- `test/release.test.mjs` (new)
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm install --save-dev --save-exact esbuild@0.25.10`.

2. `.gitignore`: add a line `release/`.

3. `src/release-key.ts`:
   ```ts
   /** ed25519 public key (SPKI PEM) that signs release SHA256SUMS files. Empty: updates can't be verified. */
   export const RELEASE_PUBLIC_KEY = "";
   ```

4. `scripts/keygen.mjs` (Node ESM, built-ins only):
   - `node scripts/keygen.mjs <private-key-path>`
   - Refuses (exit 1) if the path exists.
   - `crypto.generateKeyPairSync("ed25519")`. Writes the private key as PKCS8 PEM with mode
     `0o600` (create the parent dir if needed). Prints the public key as SPKI PEM to stdout.

5. `scripts/sign.mjs` (Node ESM, built-ins only):
   - `node scripts/sign.mjs <private-key-path> <file>`
   - Writes `<file>.sig`, containing the base64 of `crypto.sign(null, readFileSync(file), privateKey)`
     followed by a newline.

6. `src/release.ts`. Compute every path at call time from the environment, never at import time:
   - `dataDir()` = `<XDG_DATA_HOME or ~/.local/share>/agent-hive`
   - `versionsDir()` = `<dataDir>/versions`
   - `currentLink()` = `<dataDir>/current`
   - `previousLink()` = `<dataDir>/previous`
   - `rootfsDir()` = `<dataDir>/rootfs`
   - `binLink()` = `<homedir()>/.local/bin/hive`
   - `cacheFile()` = `<XDG_CACHE_HOME or ~/.cache>/agent-hive/update-check.json`
   
   `homedir()` from `node:os`, which honours `HOME`.

   Exports:
   - `compareVersions(a: string, b: string): -1 | 0 | 1`. Strips a leading `v`, compares
     dot-separated integers numerically, and treats missing parts as 0. Throws
     `Error("bad version: <x>")` if any part isn't a non-negative integer.
   - `bundleRoot(): string | undefined` = `process.env.HIVE_BUNDLE_ROOT || undefined`.
   - `currentVersion(): string | undefined`: the trimmed `<bundleRoot>/VERSION` when bundled,
     else `undefined`.
   - `parseSums(text: string): Map<string, string>`: lines `<64 hex>  <name>` (also accept a
     `*` before the name). Skips other lines.
   - `verifySums(sums: Buffer, sigBase64: string, publicKeyPem: string): boolean`: wraps
     `crypto.verify(null, sums, publicKeyPem, Buffer.from(sigBase64.trim(), "base64"))` and
     returns `false` on any exception.
   - `sha256File(path: string): Promise<string>`: hex, streamed.
   - `type ReleaseAsset = { name: string; url: string; downloadUrl: string }` and
     `type Release = { version: string; assets: ReleaseAsset[] }`.
   - `fetchRelease(tag?: string, timeoutMs = 30_000): Promise<Release>`:
     - GET `${HIVE_RELEASE_API || "https://api.github.com"}/repos/${HIVE_RELEASE_REPO || "ogsapps/agent-hive"}/releases/latest`,
       or `…/releases/tags/<tag>` when `tag` is given.
     - Headers: `Accept: application/vnd.github+json`, `User-Agent: agent-hive`, and
       `Authorization: Bearer <token>` when `GH_TOKEN` or `GITHUB_TOKEN` is set.
     - Use global `fetch` with `AbortSignal.timeout(timeoutMs)`. A non-2xx response throws
       `Error("release lookup failed: HTTP <status>")`.
     - `version` = `tag_name` without a leading `v`. Assets map `name`, `url` (the API URL) and
       `browser_download_url` to `downloadUrl`.
   - `download(asset: ReleaseAsset, dest: string, timeoutMs = 600_000): Promise<void>`:
     - With a token: GET `asset.url` with `Accept: application/octet-stream` plus the
       `Authorization` and `User-Agent` headers.
     - Without one: GET `asset.downloadUrl` with `User-Agent`.
     - Stream the body to `dest` (`Readable.fromWeb` + `pipeline`). Non-2xx throws
       `Error("download failed: <name>: HTTP <status>")`.
   - `installRelease(rel: Release, o: { publicKey?: string } = {}): Promise<string>`:
     1. `key = o.publicKey ?? RELEASE_PUBLIC_KEY`. If empty, throw
        `Error("this build has no release signing key, so updates can't be verified")`.
     2. `app = "hive-<rel.version>-linux-x86_64.tar.gz"`. Look up the assets `SHA256SUMS`,
        `SHA256SUMS.sig` and `app`. If any is missing, throw
        `Error("release v<version> has no linux-x86_64 build")`.
     3. Make `<dataDir>/.tmp-XXXXXX` (`mkdtempSync`, after `mkdirSync(dataDir, { recursive: true })`).
        Always remove it in `finally`.
     4. Download `SHA256SUMS` and `SHA256SUMS.sig`. If `!verifySums`, throw
        `Error("release signature check failed")`.
     5. Download `app`. If its `sha256File` isn't equal to `parseSums(...).get(app)` (including
        a missing entry), throw `Error("checksum mismatch: <app>")`.
     6. If `<versionsDir>/<version>/VERSION` already exists, skip extraction. Otherwise run
        `tar -xzf <app> -C <tmp>/x` (create `x` first), which must produce `<tmp>/x/hive-<version>/VERSION`
        (else throw `Error("bad app bundle")`). Then `mkdirSync(versionsDir, { recursive: true })`,
        `rmSync(<versionsDir>/<version>, { recursive: true, force: true })`, and `renameSync` it into
        place.
     7. `rver` = the trimmed `<versionsDir>/<version>/ROOTFS_VERSION`. If `rver !== "none"`, call
        `ensureRootfs(rel, rver, sums, tmp)` (below).
     8. Return `<versionsDir>/<version>`.
   - `ensureRootfs(rel: Release, rver: string, sums: Map<string, string>, tmp: string): Promise<void>`
     (exported):
     1. If `<rootfsDir>/<rver>/.complete` exists, return.
     2. `name = "hive-rootfs-<rver>-linux-x86_64.tar.gz"`. Find the asset (missing → throw
        `Error("release has no rootfs <rver>")`), download it into `tmp`, and check its sha256
        against `sums` (mismatch → `checksum mismatch: <name>`).
     3. `dir = <rootfsDir>/.tmp-<rver>`. `rmSync` it, `mkdirSync` it, then
        `tar -xzf <file> -C <dir> --no-same-owner`.
     4. `<dir>/usr/local/bin/hive-vm-init` must exist (else throw `Error("bad rootfs archive")`).
     5. Write an empty `<dir>/.complete`, then `renameSync(dir, <rootfsDir>/<rver>)`.
   - `setupRootfs(o: { publicKey?: string } = {}): Promise<string>`:
     - Bundled only (else throw `Error("not an installed release")`).
     - `rver` from `<bundleRoot>/ROOTFS_VERSION`. If `.complete` exists, return its path.
     - Otherwise `fetchRelease("v" + currentVersion())`, download and verify `SHA256SUMS` and its
       signature as in `installRelease`, and call `ensureRootfs` with a temp dir under `dataDir`,
       removed in `finally`. Return `<rootfsDir>/<rver>`.
   - `activate(version: string): void`:
     - `target = <versionsDir>/<version>`.
     - Read the old `current` target with `readlinkSync` (if any).
     - Point `current` at `target` atomically: `symlinkSync(target, current + ".tmp")`, then
       `renameSync` over `current`, after removing a stale `.tmp`.
     - If there was an old target and it differs from `target`, point `previous` at it the same
       way.
     - Then `mkdirSync(dirname(binLink()), { recursive: true })`. If `binLink()` doesn't exist or
       is a symlink, point it at `<currentLink>/bin/hive` (atomic as above). If it exists and
       isn't a symlink, leave it and print `hive: <binLink> exists and isn't a symlink; not changing it`
       to stderr.
   - `rollback(): string`:
     - Throws `Error("no previous version to roll back to")` when `previous` is missing.
     - Swaps the `current` and `previous` targets atomically and returns the new current version
       (the basename of its target).
   - `prune(): void`:
     - Removes every entry in `versionsDir` that isn't the basename of the `current` or
       `previous` target.
     - Removes every dir in `rootfsDir` whose name matches `/^[0-9a-f]{12}$/` and isn't listed in
       the `ROOTFS_VERSION` of the current or previous version.
     - Never touches symlinks, names starting with `.`, or anything else.
   - `updateNotice(): Promise<string | undefined>`:
     - Returns `undefined` unless bundled and `HIVE_NO_UPDATE_CHECK !== "1"`.
     - Reads `cacheFile()` (`{ checkedAt: number, latest: string }`). If it was checked within
       the last 24 h, use its `latest`. Otherwise `fetchRelease(undefined, 3000)`, save
       `{ checkedAt: Date.now(), latest }` (mkdir as needed), and use that.
     - If `compareVersions(latest, current) > 0`, return
       `hive: version <latest> is available (you have <current>); run hive update`.
     - Any error → `undefined`.

7. `src/cli.ts`:
   - **Prelude**, before any dynamic import and after the existing env setup. If
     `process.env.HIVE_BUNDLE_ROOT` is set:
     - `process.env.HIVE_VM_BIN ||= <root>/libexec/hive-vm`;
     - `process.env.HIVE_ROOTFS ||= <XDG_DATA_HOME or ~/.local/share>/agent-hive/rootfs/<trimmed <root>/ROOTFS_VERSION>`.
     
     Read the file with `readFileSync`, and ignore a missing file.
   - **`run`:** right after the `libkrunAvailable()` check passes, `const notice = await updateNotice()`
     (from `./release.js`), and print it to stderr if set. In bundled mode, when
     `libkrunAvailable()` is false and `HIVE_ROOTFS` doesn't exist, add the line
     `hive: run hive setup to download the VM filesystem`.
   - **New command `setup`:**
     - Bundled: `setupRootfs()`, print `hive: VM filesystem ready: <path>`, then run `doctor`
       and return its exit code.
     - From source: print
       `hive: running from source; build the VM filesystem with npm run build:image && npm run build:rootfs`,
       then run `doctor`.
   - **New command `doctor`:** prints these lines to stdout and exits 0 only if every check is ok:
     ```
     hive <currentVersion() or "dev (from source)">
     /dev/kvm: ok | missing | no access
     libkrun: ok (<HIVE_LIBKRUN or libkrun.so.1>) | not found — install your distro's libkrun package (Fedora: sudo dnf install libkrun)
     pasta: ok (<path from command -v>) | not found — install passt (Fedora: sudo dnf install passt)
     launcher: ok (<vmBin>) | missing (<vmBin>)
     rootfs: ok (<realpath>) | missing (<path>) — run hive setup
     isolation: microvm (system libkrun) | unavailable
     ```
     - `/dev/kvm`: `accessSync` R|W.
     - libkrun: the launcher `--check` with `HIVE_LIBKRUN` in env, which is how
       `libkrunAvailable` does it. Report it as `not found` if the launcher is missing.
     - rootfs: ok when `<rootfs>/usr/local/bin/hive-vm-init` exists.
     - Use `config.sandbox` for the paths.
   - **New command `update`:** options `--check` and `--rollback` (booleans).
     - Not bundled: throw `Error("hive update works for installed releases; this copy runs from source (git pull && npm run build)")`.
     - `--rollback`: `rollback()`, print `hive: back on <version>`.
     - `--check`: `fetchRelease()`. Print `hive <cur> is up to date` or
       `hive <latest> is available (you have <cur>)`.
     - Default: `fetchRelease()`. If not newer, print `hive <cur> is up to date`. Otherwise
       `installRelease(rel)`, `activate(rel.version)`, `prune()`, and print
       `hive: updated <cur> → <latest>`.
   - **Usage text:** add after the `hive clean` line:
     ```
     hive setup
     hive doctor
     hive update [--check | --rollback]
     ```

8. `scripts/build-release.sh` (bash, `set -euo pipefail`, run from the repo root):
   - `version` = `node -p "require('./package.json').version"`.
   - `NODE_VERSION=${HIVE_NODE_VERSION:-24.18.0}`.
   - `key=${HIVE_SIGNING_KEY:-$HOME/.config/agent-hive/release-signing-key.pem}`. If it's
     missing, exit 1 with `build-release: signing key <key> not found (create it with node scripts/keygen.mjs <key>)`.
   - `out=release/$version`. `rm -rf "$out"`, then `mkdir -p "$out"`. `stage=$(mktemp -d)`, with
     a trap that removes it.
   - `npm run build` and `npm run build:vm`.
   - Rootfs: unless `HIVE_RELEASE_SKIP_ROOTFS=1`, run `npm run build:image` and
     `npm run build:rootfs`, and set `rootfs=$(realpath "${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive/rootfs/current")`
     and `rver=$(basename "$rootfs")`. Then
     `tar -C "$rootfs" --exclude=./.complete -czf "$out/hive-rootfs-$rver-linux-x86_64.tar.gz" .`.
     With `HIVE_RELEASE_SKIP_ROOTFS=1`, `rver=none`.
   - App bundle at `$stage/hive-$version/`:
     - `bin/hive` (mode 755):
       ```sh
       #!/bin/sh
       root=$(dirname "$(dirname "$(readlink -f "$0")")")
       HIVE_BUNDLE_ROOT=$root exec "$root/libexec/node" "$root/lib/hive.mjs" "$@"
       ```
     - `lib/hive.mjs`:
       `npx esbuild dist/cli.js --bundle --platform=node --format=esm --target=node24 --outfile=<that path> --banner:js="import { createRequire as __hiveRequire } from 'node:module'; const require = __hiveRequire(import.meta.url);"`
     - `libexec/node`: download
       `https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz` and its
       `SHASUMS256.txt` into `$stage`. Check with `grep " node-v$NODE_VERSION-linux-x64.tar.gz\$" SHASUMS256.txt | sha256sum -c -`
       (run in `$stage`). Extract only `node-v$NODE_VERSION-linux-x64/bin/node` and copy it.
     - `libexec/hive-vm`: copied from `vm/hive-vm`.
     - `VERSION` (`$version`) and `ROOTFS_VERSION` (`$rver`), each one line.
   - `tar -C "$stage" -czf "$out/hive-$version-linux-x86_64.tar.gz" "hive-$version"`.
   - `(cd "$out" && sha256sum hive-*.tar.gz > SHA256SUMS)`, then
     `node scripts/sign.mjs "$key" "$out/SHA256SUMS"`.
   - Print `ls -l "$out"`.
   - `package.json`: add the script `"release": "bash scripts/build-release.sh"`.

9. `install-cli.sh` (POSIX `sh`, `set -eu`):
   - `REPO=${HIVE_RELEASE_REPO:-ogsapps/agent-hive}`, `API=${HIVE_RELEASE_API:-https://api.github.com}`.
   - If `uname -m` isn't `x86_64`, exit 1 with `hive: only linux x86_64 releases exist for now`.
   - Require `curl`, `tar` and `sha256sum` (`command -v`), naming any that's missing.
   - Fetch `$API/repos/$REPO/releases/latest`. Get `ver` from `"tag_name"` (strip a leading `v`)
     and the `browser_download_url` values with `sed`/`grep`.
   - Download `SHA256SUMS` and `hive-$ver-linux-x86_64.tar.gz` into a `mktemp -d` dir (removed on
     exit). Verify with `grep " hive-$ver-linux-x86_64.tar.gz\$" SHA256SUMS | sha256sum -c -`.
   - `data=${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive`. Extract into the temp dir. If
     `$data/versions/$ver` doesn't exist, move `hive-$ver` there.
   - `ln -sfn "$data/versions/$ver" "$data/current"`, `mkdir -p "$HOME/.local/bin"`,
     `ln -sfn "$data/current/bin/hive" "$HOME/.local/bin/hive"`.
   - Run `"$data/current/bin/hive" setup || true`, then print
     `hive $ver installed; make sure $HOME/.local/bin is on your PATH` (a plain message, no
     colours).
   - A comment at the top says this script checks the SHA256SUMS checksum over HTTPS, and that
     `hive update` also verifies the release signature.

10. `README.md`:
    - In `## Install`, add a first subsection `### From a release`:
      `curl -fsSL https://raw.githubusercontent.com/ogsapps/agent-hive/main/install-cli.sh | sh`,
      plus one line saying it needs `/dev/kvm` and the system's libkrun and pasta for now
      (Fedora: `sudo dnf install libkrun passt`).
    - Rename the existing build steps `### From source`.
    - Add `hive setup`, `hive doctor` and `hive update [--check | --rollback]` rows to the commands
      table.
    - Add `HIVE_NO_UPDATE_CHECK` (set to 1 to stop the daily update notice), `HIVE_RELEASE_REPO`
      (default `ogsapps/agent-hive`) and `GH_TOKEN`/`GITHUB_TOKEN` (used for release lookups when
      set) to the settings table.
    
    `docs/RELEASING.md`:
    1. one-time `node scripts/keygen.mjs ~/.config/agent-hive/release-signing-key.pem`, then paste
       the printed key into `src/release-key.ts` and commit;
    2. bump `version` in `package.json`;
    3. `npm run release`;
    4. `gh release create v<version> release/<version>/* --title v<version> --notes "<notes>"`;
    
    plus what each file in a release is.

11. `test/release.test.mjs` (`node:test` and `node:assert/strict`):
    - Before any `await import("../dist/…")`, set `HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` to
      fresh temp dirs, and `HIVE_RELEASE_API` to a local server URL (start the server first),
      `HIVE_RELEASE_REPO=o/r`, and delete `GH_TOKEN` and `GITHUB_TOKEN`.
    - **Test key:** `crypto.generateKeyPairSync("ed25519")`, with the public key exported as SPKI
      PEM.
    - **Helper `makeRelease(version, rver, { tamper })`:**
      - builds `hive-<v>/` with `VERSION`, `ROOTFS_VERSION`, and a `bin/hive` holding
        `#!/bin/sh\necho hive`;
      - `tar -czf` it, plus `hive-rootfs-<rver>-linux-x86_64.tar.gz` containing
        `usr/local/bin/hive-vm-init`;
      - writes a `SHA256SUMS` over both, signed with the test key.
      
      With `tamper: "app"`, the app tarball gets a byte appended after the sums are written. With
      `tamper: "sig"`, the signature is made with a different key.
    - **Server** (`node:http`, `127.0.0.1:0`):
      - `/repos/o/r/releases/latest` and `/repos/o/r/releases/tags/v<x>` serve
        `{ tag_name, assets: [{ name, url: <base>/api/<name>, browser_download_url: <base>/dl/<name> }] }`
        for the release currently set by the test;
      - `/dl/<name>` serves the file;
      - it counts requests per path.
    - **Tests:**
      - `compareVersions`: `1.2.0` vs `1.10.0` → -1; `v1.2` vs `1.2.0` → 0; `2.0.0` vs `1.9.9` → 1;
        `1.x` throws.
      - `verifySums`: true with the right key, false with the wrong key or a tampered body.
      - Install 1.1.0 (rootfs `aaaaaaaaaaaa`) with `installRelease(await fetchRelease(), { publicKey })`,
        then `activate("1.1.0")`:
        - `versions/1.1.0/VERSION` exists;
        - `readlinkSync(current)` ends with `/versions/1.1.0`;
        - `rootfs/aaaaaaaaaaaa/.complete` exists;
        - `<HOME>/.local/bin/hive` is a symlink.
      - Install 1.2.0 with the same rootfs version: the rootfs `/dl/` path count stays at 1. Then
        `activate("1.2.0")`: `previous` → `1.1.0` and `current` → `1.2.0`. `rollback()` returns
        `"1.1.0"` and swaps them.
      - `tamper: "app"` (1.3.0) rejects with `/checksum mismatch/`, and `current` is unchanged.
      - `tamper: "sig"` (1.4.0) rejects with `/signature/`.
      - An empty `publicKey: ""` rejects with `/signing key/`.
      - `prune()`: create `versions/0.9.0` and `rootfs/bbbbbbbbbbbb`. After `prune()` both are gone,
        and the current and previous versions plus `rootfs/aaaaaaaaaaaa` remain.
      - `updateNotice`: set `HIVE_BUNDLE_ROOT` to a temp dir whose `VERSION` is `1.1.0`, with the
        server's latest at 1.2.0. The result contains `1.2.0`. A second call makes no new request
        to `/releases/latest`. With `HIVE_NO_UPDATE_CHECK=1` it returns `undefined`. Unset both
        afterwards.
      - CLI (`execFileSync(process.execPath, ["dist/cli.js", ...])`, with `HIVE_BUNDLE_ROOT`
        unset):
        - `update` exits 1 with stderr containing `runs from source`;
        - `doctor`'s stdout starts with `hive dev (from source)` (any exit code);
        - `--help` contains `hive update`.

## Acceptance

1. `npm ci` exits 0, and `npx esbuild --version` prints `0.25.10`.
2. `npm run build` exits 0.
3. `npm test` exits 0. Its output shows the tests from `test/release.test.mjs` passing and `fail 0`.
4. `node dist/cli.js --help` contains lines starting with `hive setup`, `hive doctor` and `hive update`.
5. `node dist/cli.js update; echo "exit=$?"` prints `exit=1`, and stderr contains `runs from source`.
6. `K=$(mktemp -d)/k.pem && node scripts/keygen.mjs $K > /tmp/pub.pem && HIVE_RELEASE_SKIP_ROOTFS=1 HIVE_SIGNING_KEY=$K npm run release` exits 0. `release/<version>/` (version from `package.json`) contains `hive-<version>-linux-x86_64.tar.gz`, `SHA256SUMS` and `SHA256SUMS.sig`.
7. `T=$(mktemp -d) && tar -xzf release/*/hive-*-linux-x86_64.tar.gz -C $T && $T/hive-*/bin/hive --help` prints the usage text, including `hive update`. This runs the bundled Node and bundled CLI.
8. `(cd release/* && sha256sum -c SHA256SUMS)` exits 0, and
   `node -e "const c=require('crypto'),f=require('fs'),d=process.argv[1];process.exit(c.verify(null,f.readFileSync(d+'/SHA256SUMS'),f.readFileSync('/tmp/pub.pem'),Buffer.from(f.readFileSync(d+'/SHA256SUMS.sig','utf8').trim(),'base64'))?0:1)" release/*`
   exits 0.
9. `sh -n install-cli.sh` and `bash -n scripts/build-release.sh` exit 0.
10. `git diff --quiet HEAD -- src/index.ts src/auth.ts src/routes src/tasks.ts src/sandbox.ts src/runs.ts src/git.ts ui image vm` exits 0.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches. Do not touch files outside **Files to touch** except
  `.handoff/report.md`. Installing dependencies and temporary files outside the repo are fine.
- The only new dependency is the devDependency `esbuild@0.25.10`. Runtime code uses Node
  built-ins only.
- Don't change `src/sandbox.ts`, `src/runs.ts`, `src/git.ts`, `src/tasks.ts`, `src/index.ts`,
  `src/auth.ts`, `src/routes/`, `ui/`, `image/` or `vm/`.
- No private keys anywhere in the repo. `src/release-key.ts` stays an empty string. Tests generate
  their own keys.
- Updates never leave a half-installed version in place: extract into temp dirs and `rename` into
  place. Symlinks are switched by renaming a temp symlink over the old one.
- Strict TypeScript, ES modules.

## Out of scope

Bundling libkrun, libkrunfw or pasta (step 2), gVisor (step 3), arm64 and macOS, rpm and deb
packages, publishing a release, and any change to the server or the VM launcher.

## If blocked

If a step is wrong or impossible as written, stop. Write what blocked you and where in
`.handoff/report.md`, and don't improvise around it.
