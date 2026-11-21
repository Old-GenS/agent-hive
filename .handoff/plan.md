## Goal

Update automation for agent-hive: a `beta` release channel signed by a second key, CI with real
microVM tests on every pull request, a daily check that opens version-bump PRs against `beta`,
Dependabot, auto-merge into `beta`, and a daily signed beta prerelease built in GitHub Actions
that reuses the previous VM rootfs unless it needs rebuilding.

The GitHub side already exists (do not touch it): branch `beta`; environment `beta-release`
(deployments only from `beta`) holding the secret `BETA_SIGNING_KEY` (an ed25519 PKCS#8 PEM);
repo auto-merge on; Actions may create PRs. The stable key never leaves the maintainer's machine.

Beta public key (SPKI PEM):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWdnEWR0UkzDTAxMQCbeb4/klDgiRDcRruujT3WNdcEs=
-----END PUBLIC KEY-----
```

## Files to touch

- `src/release-key.ts`, `src/release.ts`, `src/cli.ts`
- `test/release.test.mjs`, `test/cli.test.mjs` (only if a CLI help/usage assertion changes)
- `scripts/build-release.sh`
- `scripts/check-updates.mjs` (new), `scripts/rootfs-plan.mjs` (new), `scripts/vm-smoke.mjs` (new),
  `scripts/ci-enable-kvm.sh` (new)
- `test/check-updates.test.mjs` (new), `test/rootfs-plan.test.mjs` (new)
- `.github/dependabot.yml`, `.github/workflows/ci.yml`, `.github/workflows/bump.yml`,
  `.github/workflows/beta.yml`, `.github/workflows/dependabot-automerge.yml`,
  `.github/workflows/sync-beta.yml` (all new)
- `docs/RELEASING.md`, `docs/CLI.md`, `docs/ROADMAP.md`, `README.md`, `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. Release channel (client):
   - `src/release-key.ts`: keep `RELEASE_PUBLIC_KEY`; add `export const BETA_RELEASE_PUBLIC_KEY`
     with the beta key above, and a comment: beta prereleases are signed in CI with this key;
     installs on the stable channel never accept it.
   - `src/release.ts`:
     - `compareVersions(a, b)`: accept `X.Y.Z` with an optional `-beta.N` (N numeric), leading `v`
       allowed. A prerelease sorts below the same `X.Y.Z` without suffix; two betas of the same
       `X.Y.Z` compare by N. Anything else still throws `bad version: <v>`. Add
       `export function isBeta(version: string): boolean`.
     - `export type Channel = "stable" | "beta"`; `export function channelFile()` =
       `<dataDir()>/channel`; `export function readChannel(): Channel` (file missing or content not
       `beta` → `"stable"`); `export function writeChannel(c: Channel)` (mkdir dataDir, write
       `c + "\n"`).
     - `export function trustedKeys(channel: Channel): string[]`: stable → `[RELEASE_PUBLIC_KEY]`;
       beta → `[RELEASE_PUBLIC_KEY, BETA_RELEASE_PUBLIC_KEY]`. Empty strings are dropped.
     - `verifySums` unchanged; add `verifySumsAny(sums, sig, keys: string[])` = true if any key
       verifies.
     - `fetchRelease(tag?, timeoutMs = 30_000, channel: Channel = "stable")`: with a tag, as now.
       Without a tag: stable → `/releases/latest` as now; beta → `GET
       /repos/<repo>/releases?per_page=30`, drop drafts and tags `compareVersions` can't parse, and
       return the highest version (stable or prerelease). Error `no releases found` when none.
     - `installRelease(rel, o: { publicKeys?: string[] } = {})`: keys default to
       `trustedKeys(readChannel())`; signature check uses `verifySumsAny`; empty key list → the
       existing "no release signing key" error.
     - `setupRootfs(o: { publicKeys?: string[]; onProgress? })`: keys default to
       `trustedKeys(isBeta(currentVersion() ?? "0.0.0") ? "beta" : readChannel())`.
     - `updateNotice()` (the daily check): use `fetchRelease(undefined, …, readChannel())`.
     - Update every existing caller/test that passes `publicKey` to pass `publicKeys: [...]`.
   - `src/cli.ts` `cmdUpdate`: new option `--channel <stable|beta>` (any other value → error
     `--channel must be stable or beta`). When given, `writeChannel()` it and print
     `hive: update channel is now <c>`; then continue with the normal update (or `--check`) on that
     channel. `fetchRelease(undefined, undefined, readChannel())`. Output of `--check` and
     "up to date" lines gain ` (<channel> channel)` when the channel is beta. Switching to stable
     never downgrades: if the current version is a beta newer than the latest stable, print
     `hive <cur> is newer than the latest stable release (<v>); you'll get the next stable release`
     and exit 0. Usage line becomes `hive update [--check | --rollback | --channel stable|beta]`.
     Doctor: add a line `update channel   <stable|beta>` next to the version line, in the same
     style as its neighbours.
   - `test/release.test.mjs`: compareVersions with betas (`0.5.1-beta.2 < 0.5.1-beta.10 < 0.5.1`,
     `0.5.0 < 0.5.1-beta.1`, `0.5.1-rc.1` throws); readChannel/writeChannel under a temp
     `XDG_DATA_HOME`; trustedKeys; `fetchRelease` on the beta channel against the existing local fake
     API pattern in that file (a list with a draft, a stable and a higher prerelease → the
     prerelease; stable channel still uses `/releases/latest`); `installRelease` accepts SUMS signed
     by a second test key only when that key is in `publicKeys`.

3. `scripts/build-release.sh`:
   - `HIVE_RELEASE_VERSION` overrides the package.json version; it must match
     `^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$` or exit 1 with a clear message.
   - `HIVE_RELEASE_REUSE_ROOTFS=<path to hive-rootfs-<rver>-linux-x86_64.tar.gz>`: skip the image
     and rootfs build; `rver` is parsed from the file name (12 hex; error otherwise); copy the file
     into `$out/`. If a `rootfs-info.json` sits next to it, copy that to `$out/` too, else exit 1.
   - When the rootfs is built, write `$out/rootfs-info.json`:
     `{"rootfs":"<rver>","imageTree":"<git rev-parse HEAD:image>","built":"<UTC ISO-8601 now>"}`.
     With `HIVE_RELEASE_SKIP_ROOTFS=1`, write none.
   - `rootfs-info.json` is not in `SHA256SUMS` (clients never read it).

4. `scripts/vm-smoke.mjs` (new). Usage: `node scripts/vm-smoke.mjs` with `HIVE_BUNDLE_ROOT` set
   to an extracted release bundle and that bundle's rootfs already under
   `~/.local/share/agent-hive/rootfs/<ROOTFS_VERSION>` (set `HIVE_ROOTFS` to it). It imports
   `../dist/sandbox.js` (run `npm run build` first) and checks, printing `ok <name>` or
   `FAIL <name>: <detail>` per check, exit 1 if any fail:
   - `runtime`: `detectRuntime()` reports microvm and the libkrun/pasta labels are printed.
   - In ONE `runSandbox` VM (network mode proxy, the default), run a bash script that prints one
     JSON line per check to stdout (it lands in `<ioDir>/events.jsonl`; collect them with
     `onEvent`):
     - `https`: `curl -sS -o /dev/null -w '%{http_code}' --max-time 30 https://example.com` → `200`.
     - `lan-refused`: before booting, the host script starts an HTTP server on `0.0.0.0` on a free
       port and finds the host's first non-internal private IPv4 (`os.networkInterfaces()`;
       10/8, 172.16/12, 192.168/16) and checks from the host that `http://<ip>:<port>/` answers.
       In the VM: through the proxy the status is `403`; with `--noproxy '*' --max-time 5` curl
       exits non-zero.
     - `metadata-refused`: `curl` via proxy to `http://169.254.169.254/` → `403`.
     - `chromium`: `chromium-browser --headless --no-sandbox --disable-gpu --dump-dom
       https://example.com` (timeout 90 s) output contains `Example Domain`.
   - `fake-key-run`: make a temp git repo with one commit and a configured identity, then run the
     bundle's `bin/hive run` there non-interactively on provider OpenRouter (read `docs/CLI.md` and
     `src/cli.ts` for the flags) with `OPENROUTER_API_KEY=sk-or-v1-ci-fake` and a fresh temp
     `HIVE_HOME`/keys location so no real key is used, timeout 10 minutes. Pass when the run ends
     and its logs/output (find where `src/runs.ts` writes the run's events and stderr) match
     `/401|unauthori[sz]ed|invalid.{0,20}(api )?key|no auth|user not found/i` and do not match
     `/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|getaddrinfo/`. Print the matching
     line. Delete the temp repo and run afterwards.
   - Clean up temp dirs and the HTTP server in a `finally`.

5. `scripts/ci-enable-kvm.sh` (new): for GitHub's Ubuntu runners: write the udev rule
   `KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"` to
   `/etc/udev/rules.d/99-kvm4all.rules`, `udevadm control --reload-rules`, `udevadm trigger
   --name-match=kvm`; `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` if that key
   exists; `apt-get install -y passt`; print `ls -l /dev/kvm` and `pasta --version`. Uses `sudo`.

6. `scripts/rootfs-plan.mjs` (new). Decides whether a beta build reuses the last rootfs.
   Export `export function decide({ info, imageTree, now, securityUpdates, anyUpdates, force })`
   returning `{ action: "reuse" | "rebuild", reason: string }`:
   - `force` → rebuild ("forced"); no `info` → rebuild ("no previous rootfs");
     `info.imageTree !== imageTree` → rebuild ("image/ changed");
     `securityUpdates > 0` → rebuild ("<n> security updates");
     `anyUpdates > 0` and `now - info.built >= 14 days` → rebuild ("<n> updates, rootfs is <d> days old");
     else reuse ("rootfs <rver> is current").
   - CLI: `node scripts/rootfs-plan.mjs --info <file|-> --image-tree <hash> [--security N] [--updates N] [--force]`
     prints the JSON result. `test/rootfs-plan.test.mjs` covers every branch.

7. `scripts/check-updates.mjs` (new), plain Node 24 (fetch, no deps). Components and sources:
   - `libkrun`: GitHub `repos/containers/libkrun/releases/latest`; commit via
     `git ls-remote https://github.com/containers/libkrun refs/tags/<tag>^{}` (fall back to the
     non-dereferenced ref); updates `libkrun.version/tag/commit`.
   - `libkrunfw`: GitHub `repos/containers/libkrunfw/releases/latest`; download
     `libkrunfw-x86_64.tgz` from that release and hash it; updates `version`, `url`, `sha256`,
     `source` (`https://github.com/containers/libkrunfw/archive/refs/tags/v<v>.tar.gz`).
   - `passt`: `git ls-remote --tags https://passt.top/passt`, tags matching
     `^\d{4}_\d{2}_\d{2}\.[0-9a-f]+$`, newest by date; download
     `https://passt.top/passt/snapshot/passt-<tag>.tar.xz` and hash it.
   - `rust`: `https://static.rust-lang.org/dist/channel-rust-stable.toml`, the `[pkg.rust]`
     `version` (first word).
   - `buildImage`: `https://quay.io/api/v1/repository/pypa/manylinux_2_28_x86_64/tag/?specificTag=latest&onlyActiveTags=true`,
     `manifest_digest` → `quay.io/pypa/manylinux_2_28_x86_64@<digest>`.
   - `node`: `https://nodejs.org/dist/index.json`, newest version with the pinned major.
   - `pi`: `https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest` `.version`;
     updates `ARG PI_VERSION=` in `image/Containerfile`.
   - Version comparison per component (dotted numbers; passt by tag date; buildImage by digest
     inequality). Pure helpers exported for tests (parsers for the toml, passt tags, the
     Containerfile ARG; `applyUpdate(name, current files, found)` returning new file contents).
   - CLI: `--list` prints a JSON array `[{name, current, latest}]` of components with an update
     (network errors for one component print a warning to stderr and skip it);
     `--apply <name>` re-checks that component and writes the files (versions.json keeps 2-space
     indent and trailing newline). GitHub calls send `Authorization: Bearer $GITHUB_TOKEN` when set.
   - `test/check-updates.test.mjs`: the pure helpers with fixture strings (no network).

8. Workflows. Every third-party action pinned to a full commit SHA with a `# vX.Y.Z` comment
   (resolve each with `git ls-remote --tags https://github.com/<owner>/<repo>` for its latest
   release tag): `actions/checkout`, `actions/setup-node`, `actions/cache`,
   `dependabot/fetch-metadata`. No other third-party actions; use `gh` for GitHub operations.
   Top-level `permissions: contents: read` everywhere; widen per job only as listed. Node from
   `versions.json` (`node-version-file` can't read it: read it in a step with
   `node -p "require('./versions.json').node"` after setup-node installs `24`, or pass the value).
   Every job on `ubuntu-24.04`.
   - `ci.yml` — on `pull_request` (branches `main`, `beta`), `push` (branches `main`, `beta`),
     `workflow_dispatch`. `concurrency: ci-${{ github.ref }}`, cancel-in-progress for PRs.
     - job `test`: checkout, setup-node, `git config --global user.name ci`/`user.email
       ci@example.invalid`, `npm ci`, `npm test`, `npm run build:ui`,
       `bash -n` on every `scripts/*.sh` and `vm/*.sh`.
     - job `vm` (needs `test`, timeout 75 min): checkout, setup-node, `npm ci`,
       `bash scripts/ci-enable-kvm.sh`, `actions/cache` for `build/native` keyed on
       `hashFiles('versions.json','vm/hive-vm.c','scripts/build-native.sh','scripts/native-in-container.sh')`,
       create a throwaway key in `$RUNNER_TEMP` with `node scripts/keygen.mjs`, then
       `HIVE_SIGNING_KEY=… HIVE_RELEASE_SKIP_SOURCES=1 npm run release`, extract the app tarball to
       `$RUNNER_TEMP/bundle`, extract the rootfs tarball to
       `~/.local/share/agent-hive/rootfs/<rver>` (inside `podman unshare` like the build packs it,
       or with `--no-same-owner`; match what `src/release.ts` `ensureRootfs` does), then
       `HIVE_BUNDLE_ROOT=$RUNNER_TEMP/bundle/hive-<version> HIVE_ROOTFS=… node scripts/vm-smoke.mjs`.
   - `bump.yml` — `schedule` daily `23 4 * * *`, `workflow_dispatch`. Permissions
     `contents: write`, `pull-requests: write`, `actions: write`. Checkout `beta`, setup-node,
     `node scripts/check-updates.mjs --list`. For each entry: branch
     `auto/<name>-<latest with unsafe chars replaced by ->`; skip if it exists on origin; else
     create it from `origin/beta`, `--apply <name>`, commit as
     `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>` with message
     `Bump <name> <current> → <latest>`, push, `gh pr create --base beta --head <branch>` (body:
     component, old → new, the source URL, and "Merges automatically when CI passes, including the
     real VM test."), `gh workflow run ci.yml --ref <branch>` (PRs opened with GITHUB_TOKEN don't
     start workflows on their own; this run's checks land on the same commit), then
     `gh pr merge --auto --squash <url>`. Uses `GH_TOKEN: ${{ github.token }}`.
   - `dependabot-automerge.yml` — `pull_request` on `beta`; job runs only if
     `github.actor == 'dependabot[bot]'`; permissions `contents: write`, `pull-requests: write`;
     `dependabot/fetch-metadata`; if `update-type` is not `version-update:semver-major`,
     `gh pr merge --auto --squash "$PR_URL"`.
   - `sync-beta.yml` — `push` on `main`. Permissions `contents: read`, `pull-requests: write`. If
     no open PR from `main` to `beta` exists, `gh pr create --base beta --head main --title "Sync
     main into beta" --body …`; then `gh pr merge --auto --merge` on it. (CI already ran on the
     main push for that commit.)
   - `beta.yml` — `schedule` daily `41 5 * * *`, `workflow_dispatch` with boolean input
     `fresh_rootfs`. `concurrency: beta-release`, no cancel.
     - job `plan` (permissions `contents: read`): checkout `beta` with `fetch-depth: 0`. With `gh
       api`, find the newest release (any, including stable) that has a `rootfs-info.json` asset
       and download it, and the newest `v*-beta.*` prerelease tag. Image tree:
       `git rev-parse HEAD:image`. If the tree matches the info, download that release's rootfs
       tarball, `podman import` it, and count updates inside it:
       `podman run --rm <img> dnf -q updateinfo list --updates --security` (lines) and
       `dnf -q check-update` (package lines; exit code 100 means updates). Then
       `node scripts/rootfs-plan.mjs …`. Outputs: `build` = true when beta HEAD differs from the
       newest beta tag's commit, or the plan says rebuild, or there is no beta tag yet;
       `rootfs` = reuse|rebuild; `reason`; `reuse_tag` (the release the rootfs comes from).
       Version: package.json `X.Y.Z` → `X.Y.(Z+1)-beta.${{ github.run_number }}`.
     - job `release` (needs `plan`, if `build`, `environment: beta-release`, permissions
       `contents: write`, timeout 90 min): same setup as `ci.yml` `vm` (KVM, native cache). Write
       `secrets.BETA_SIGNING_KEY` to `$RUNNER_TEMP/beta.pem` (umask 077), delete it in an
       `if: always()` step. If reuse: `gh release download <reuse_tag>` the rootfs tarball and
       `rootfs-info.json` into `$RUNNER_TEMP/reuse/` and set `HIVE_RELEASE_REUSE_ROOTFS`. Run
       `HIVE_RELEASE_VERSION=<v> HIVE_SIGNING_KEY=$RUNNER_TEMP/beta.pem npm run release` (with the
       GPL sources). Verify `SHA256SUMS.sig` against `BETA_RELEASE_PUBLIC_KEY` from
       `src/release-key.ts` with a short node script (fail on mismatch). Run the same bundle +
       rootfs extraction and `scripts/vm-smoke.mjs` as `ci.yml`. Only then
       `gh release create v<v> --prerelease --target <beta sha> --title v<v> --notes-file …
       release/<v>/*` with notes: the commits since the previous beta tag (`git log --oneline`),
       the rootfs line (`reused from <tag>` or `rebuilt: <reason>`), and how to opt in
       (`hive update --channel beta`).
   - `.github/dependabot.yml`: version 2; ecosystems `npm` at `/` and at `/ui`, and
     `github-actions` at `/`; `target-branch: beta`; schedule daily; one group per ecosystem for
     `minor` and `patch` updates; `open-pull-requests-limit: 5`.

9. Docs:
   - `docs/RELEASING.md`: new section "Automation and the beta channel": the two keys (stable local
     only, beta in the `beta-release` environment secret; stable installs never accept the beta
     key; how to rotate the beta key: new keypair, update `BETA_RELEASE_PUBLIC_KEY` and the secret);
     the branches (`main` → auto PR into `beta`; bump and Dependabot PRs into `beta`, merged
     automatically when `test` and `vm` pass; majors wait for a human); the daily bump check and
     what each component's source is; the daily beta prerelease and the rootfs rule (reuse unless
     image/ changed, pending security updates, or 14+ days old with updates, or `fresh_rootfs`);
     promotion: merge `beta` into `main` with a PR, bump `package.json`, cut the stable release
     locally as before, optionally `HIVE_RELEASE_REUSE_ROOTFS=<beta's rootfs tarball>` to ship the
     rootfs beta already tested; the new env vars `HIVE_RELEASE_VERSION`,
     `HIVE_RELEASE_REUSE_ROOTFS` and `rootfs-info.json`. Also: the `beta` branch protection the
     maintainer sets (required checks `test` and `vm`).
   - `docs/CLI.md`: `hive update --channel stable|beta`.
   - `README.md`: one line under updating: `hive update --channel beta` for daily prereleases.
   - `docs/ROADMAP.md`: mark the update automation done.
   - `AGENTS.md`: layout rows for `.github/workflows/`, `scripts/check-updates.mjs`,
     `scripts/rootfs-plan.mjs`, `scripts/vm-smoke.mjs`, `scripts/ci-enable-kvm.sh`.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/release.test.mjs test/check-updates.test.mjs test/rootfs-plan.test.mjs` exits 0 (after `npm run build`).
- `for f in scripts/*.sh vm/*.sh; do bash -n "$f" || exit 1; done` exits 0.
- `node --check scripts/vm-smoke.mjs && node --check scripts/check-updates.mjs && node --check scripts/rootfs-plan.mjs` exits 0.
- `bash <(curl -sSfL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) && ./actionlint -color=never` exits 0 (then delete `./actionlint`).
- `node scripts/check-updates.mjs --list` exits 0 and prints a JSON array.
- `echo '{"rootfs":"0123456789ab","imageTree":"abc","built":"2026-01-01T00:00:00Z"}' | node scripts/rootfs-plan.mjs --info - --image-tree abc` prints JSON containing `"action":"reuse"`.
- `grep -rn "uses: " .github/workflows | grep -v "@[0-9a-f]\{40\}"` prints nothing.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Don't try podman (it can't run in this
  VM); never boot a hive VM, start `hive run`, start the server or call OpenRouter. GitHub, quay,
  nodejs.org, npm, rust-lang.org and passt.top may be read (no writes, no `gh` commands). If
  something outside Acceptance fails, note it in the report and finish.
- No new npm dependencies. Don't change `vm/`, `image/` or `ui/`; don't run `check-updates.mjs --apply`.
- Never put personal names or email addresses in any file; the bot identity above is the only
  one.
- Never mention pi-vm or dsh in docs or code.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- The Settings editor, macOS, WSL, `install-cli.sh` channel support, changing the network or
  sandbox code.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
