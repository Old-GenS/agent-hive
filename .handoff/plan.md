## Goal

Bundle libkrun and libkrunfw in the release so `hive` works on distros without a libkrun package
(Ubuntu, Debian, Mint, WSL distros), following `docs/ROADMAP.md` "Step 2 — Bundle libkrun and
libkrunfw" (read it first; this plan implements it exactly):

- `versions.json` pins libkrun, libkrunfw, Rust, the build image and Node.
- `scripts/build-native.sh` builds the launcher (`hive-vm`, hardened) and libkrun inside the pinned
  `manylinux_2_28` container (glibc 2.28), downloads and verifies libkrunfw, and refuses output that
  needs newer glibc symbols or unexpected libraries.
- The release bundle ships `lib/libkrun.so.1`, `lib/libkrunfw.so.5`, licenses, and the
  old-glibc launcher; the release also uploads libkrunfw's GPL source.
- At run time hive picks libkrun in this order: `HIVE_LIBKRUN`, system libkrun (only if the
  launcher's `--check` passes), bundled libkrun; and says which one everywhere it reports isolation.
- pasta is NOT bundled (system package).

## Files to touch

- `versions.json` (new)
- `scripts/build-native.sh` (new)
- `scripts/native-in-container.sh` (new)
- `scripts/build-release.sh`
- `vm/build.sh`
- `.gitignore`
- `src/libkrun.ts` (new)
- `src/config.ts`
- `src/sandbox.ts`
- `src/cli.ts`
- `src/fixes.ts`
- `src/routes/system.ts` (only if it reports libkrun; see step 6)
- `test/libkrun.test.mjs` (new)
- `test/versions.test.mjs` (new)
- `test/fixes.test.mjs`
- existing tests that assert the old libkrun texts (update them; list each in the report)
- `docs/RELEASING.md`, `docs/THIRD-PARTY.md`, `docs/CONFIGURATION.md`, `docs/HOW-IT-WORKS.md`,
  `README.md`, `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `versions.json` (new, repo root), exactly these keys and values:
   ```json
   {
     "libkrun": {
       "version": "1.19.8",
       "repo": "https://github.com/containers/libkrun",
       "tag": "v1.19.8",
       "commit": "c4d283c233bc0ae1993c289ec2a1b4da2242f1f8"
     },
     "libkrunfw": {
       "version": "5.6.4",
       "url": "https://github.com/containers/libkrunfw/releases/download/v5.6.4/libkrunfw-x86_64.tgz",
       "sha256": "25a5554137dcc11dd71246627264f67539154ee783aa8450acfa79139e802e64",
       "source": "https://github.com/containers/libkrunfw/archive/refs/tags/v5.6.4.tar.gz"
     },
     "rust": "1.99.0",
     "buildImage": "quay.io/pypa/manylinux_2_28_x86_64@sha256:55a36963bc0504cdf004011001c1072306402f0b8b83be5a5eba7068f93eec53",
     "node": "24.18.0"
   }
   ```
   The libkrunfw tarball contains `lib/x86_64-linux-gnu/libkrunfw.so.5.6.4` (plus two symlinks).

3. `scripts/build-native.sh` (new, bash, `set -euo pipefail`, runs from any cwd, cds to the repo
   root). Output: `build/native/` containing `lib/libkrun.so.1`, `lib/libkrunfw.so.5`,
   `libexec/hive-vm`, `share/licenses/libkrun/` and `share/licenses/libkrunfw/`, and a `STAMP` file
   holding the sha256 of `versions.json` plus the sha256 of `vm/hive-vm.c`.
   - If `build/native/STAMP` matches the current values, print `build/native is up to date` and
     exit 0 (unless `--force`).
   - Read every pin from `versions.json` with `node -e` (no jq).
   - **libkrunfw (on the host):** download `libkrunfw.url` with `curl -fsSL` into a `mktemp -d`
     dir, check `sha256sum` against `libkrunfw.sha256` (exit 1 with a clear message on mismatch),
     extract, copy `lib/x86_64-linux-gnu/libkrunfw.so.<version>` to
     `build/native/lib/libkrunfw.so.5` (a regular file, mode 755). Download `libkrunfw.source`
     too and copy its license files (every top-level file whose name starts with `LICENSE` or
     `COPYING`) into `build/native/share/licenses/libkrunfw/`.
   - **Container build:** `podman run --rm --security-opt label=disable` on `buildImage` (exact
     digest from versions.json), with the repo mounted read-only at `/src` and a fresh
     `mktemp -d` output dir mounted read-write at `/out`, passing the pins as `-e` variables,
     running `bash /src/scripts/native-in-container.sh`. Then move the container's output into
     `build/native/` (replace the old dir only after the build succeeded).
   - Write `STAMP` last. Print the output dir.
   - Exit 1 with `build-native: podman is required` if podman is missing.

4. `scripts/native-in-container.sh` (new, bash, `set -euo pipefail`; runs inside the manylinux
   container as root; reads `LIBKRUN_REPO`, `LIBKRUN_TAG`, `LIBKRUN_COMMIT`, `RUST_VERSION` from
   the environment; writes only under `/out`):
   - Install the build needs with `dnf` (at least `glibc-static` for libkrun's static init blob;
     enable the repo that carries it on AlmaLinux 8, e.g. `--enablerepo=powertools`, falling back
     to `crb` if that name is what exists), plus `git` and `patchelf` if not already present.
   - Install Rust with rustup: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s
     -- -y --profile minimal --default-toolchain "$RUST_VERSION"`, then `source
     "$HOME/.cargo/env"`.
   - `git clone --depth 1 --branch "$LIBKRUN_TAG" "$LIBKRUN_REPO" /tmp/libkrun`; fail unless
     `git -C /tmp/libkrun rev-parse HEAD` equals `$LIBKRUN_COMMIT`.
   - `make -C /tmp/libkrun` with default features (no GPU, sound, BLK, NET, SEV, TDX options).
   - Copy the built `target/release/libkrun.so.<full version>` (the real file, not a symlink) to
     `/out/lib/libkrun.so.1`; `patchelf --set-rpath '$ORIGIN' /out/lib/libkrun.so.1` (this sets
     DT_RUNPATH); `strip --strip-unneeded` it. Copy libkrun's `LICENSE` (and `NOTICE` if present)
     to `/out/share/licenses/libkrun/`.
   - Build the launcher: `cc -std=c11 -O2 -Wall -Wextra -Werror -D_GNU_SOURCE
     -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now -o
     /out/libexec/hive-vm /src/vm/hive-vm.c` (use `-ldl` if the link needs it on glibc 2.28).
   - **Checks (exit 1 with a message naming the file and the problem):**
     - for `/out/lib/libkrun.so.1` and `/out/libexec/hive-vm`: the highest `GLIBC_x.y` in
       `objdump -T` is ≤ 2.28 (compare with `sort -V`);
     - their `NEEDED` entries (`readelf -d`) are all in: `libc.so.6`, `libm.so.6`, `libdl.so.2`,
       `libpthread.so.0`, `librt.so.1`, `libgcc_s.so.1`, `ld-linux-x86-64.so.2`;
     - `libkrun.so.1` has `RUNPATH` exactly `$ORIGIN` and SONAME `libkrun.so.1`;
     - `hive-vm` is PIE (`readelf -h` type `DYN`), has a `GNU_RELRO` program header and `BIND_NOW`
       (`FLAGS` containing `BIND_NOW` or `FLAGS_1` containing `NOW`).
   - Print each check's result.

5. `vm/build.sh` (the source-checkout build): add the same hardening flags
   (`-fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now`) to `flags`.
   `.gitignore`: add `build/`.

6. `src/libkrun.ts` (new):
   - `export type LibkrunSource = "custom" | "system" | "bundled";`
   - `export function libkrunCandidates(env: NodeJS.ProcessEnv, bundle: string | undefined,
     exists: (p: string) => boolean = existsSync): { path: string; source: LibkrunSource }[]` —
     `env.HIVE_LIBKRUN` set (non-empty) → only `[{ path: it, source: "custom" }]`; else
     `[{ path: "libkrun.so.1", source: "system" }]` plus, when `bundle` is set and
     `<bundle>/lib/libkrun.so.1` exists, `{ path: that, source: "bundled" }`.
   - `export function pickLibkrun(candidates, check: (path: string) => boolean): { path; source;
     ok: boolean }` — the first candidate whose `check` passes, `ok: true`; none pass → the first
     candidate with `ok: false`.
   - `export function libkrunChoice()`: memoized (computed once per process):
     `pickLibkrun(libkrunCandidates(process.env, bundleRoot()), path => launcher --check passes)`
     where the check runs `execFileSync(config.sandbox.vmBin, ["--check"], { env: { ...process.env,
     HIVE_LIBKRUN: path }, stdio: "ignore", timeout: 10_000 })` and returns false on any throw or
     when the launcher file is missing. `bundleRoot` comes from `src/release.ts`.
   - `export function libkrunLabel(c): string` — `"bundled libkrun"`, `"system libkrun"`, or
     `"libkrun from HIVE_LIBKRUN"`.
   - `src/config.ts`: `sandbox.libkrun` becomes `process.env.HIVE_LIBKRUN || ""` with a comment
     that the effective library comes from `libkrunChoice()` in `src/libkrun.ts`.
   - Replace every use of `config.sandbox.libkrun` as a library path (`src/sandbox.ts` launcher env
     at the sandbox start, `libkrunAvailable`, `checkSandbox`; `src/cli.ts` doctor) with
     `libkrunChoice().path` (and `.ok` where the code ran `--check` itself, instead of running it
     again). Search `HIVE_LIBKRUN` and `sandbox.libkrun` in `src/` to find them all.
   - Reported text:
     - `hive doctor`: the libkrun line becomes `ok (<label>: <path>)` when ok; the isolation line
       `microvm (<label>)` instead of the hard-coded `microvm (system libkrun)`; when not ok, the
       libkrun detail is `not found` and the distro-aware fix from `fixFor` (below) is what tells
       the user what to do (remove the hard-coded Fedora hint from the detail; keep the pasta line
       as it is).
     - `checkSandbox()` (Settings › This computer and onboarding): the libkrun check's `detail`
       is `<label> (<path>)` when ok, else the path tried.
     - If `src/routes/system.ts` reports a libkrun path or isolation string, make it use the same
       label. Don't change `ui/`.

7. `src/fixes.ts`:
   - `fixFor` gets an optional third parameter `detail?: string` (callers pass the check's
     detail; update both call sites).
   - `"kvm"`: when not WSL and `detail` contains `no access`: `{ text: "Add yourself to the kvm
     group, then log out and back in.", command: "sudo usermod -aG kvm $USER" }`. Other cases as
     today.
   - `"libkrun"`: when `host.bundle` is true: `{ text: "The libkrun bundled with hive didn't load;
     reinstall hive.", command: INSTALL_CLI }` for every distro. Otherwise (source checkout):
     dnf family as today; Debian/Ubuntu: `{ text: "Debian and Ubuntu don't package libkrun;
     install the hive release, which bundles it.", command: INSTALL_CLI }`; others as today.
   - `"pasta"`: unchanged.

8. `scripts/build-release.sh`:
   - Read the Node version from `versions.json` (`HIVE_NODE_VERSION` still overrides).
   - Run `bash scripts/build-native.sh` and use its output: copy `build/native/lib/libkrun.so.1`
     and `build/native/lib/libkrunfw.so.5` into `$app/lib/`, `build/native/libexec/hive-vm` into
     `$app/libexec/hive-vm` (NOT `vm/hive-vm` any more), and `build/native/share/licenses` into
     `$app/share/licenses`. Also copy hive's own `LICENSE` to `$app/share/licenses/agent-hive/`.
   - Remove `npm run build:vm` from the release script (the release launcher comes from
     build-native).
   - **GPL source assets:** download `libkrunfw.source` to
     `$out/libkrunfw-<version>-source.tar.gz`; read `FULL_VERSION` and `KERNEL_VERSION` from the
     `Makefile` inside it and download
     `https://github.com/libkrun/linux/archive/refs/tags/v<FULL_VERSION>-<KERNEL_VERSION>.tar.gz`
     to `$out/linux-<FULL_VERSION>-<KERNEL_VERSION>-source.tar.gz`. Include both in `SHA256SUMS`
     (change the `sha256sum hive-*.tar.gz` line so these two are listed too). Skip both when
     `HIVE_RELEASE_SKIP_SOURCES=1`.
   - Everything else (signing, rootfs, layout) stays.

9. Tests:
   - `test/libkrun.test.mjs` (new): `libkrunCandidates` with `HIVE_LIBKRUN` set → one custom
     candidate; without it and no bundle → system only; with a bundle dir whose
     `lib/libkrun.so.1` exists (fake `exists`) → system then bundled; bundle set but file missing →
     system only. `pickLibkrun`: system passes → system; system fails, bundled passes → bundled;
     none pass → first candidate with `ok: false`. `libkrunLabel` texts.
   - `test/versions.test.mjs` (new): `versions.json` parses; `libkrun.commit` is 40 hex;
     `libkrunfw.sha256` is 64 hex; `libkrunfw.url` and `libkrunfw.source` start with
     `https://github.com/containers/libkrunfw/`; `buildImage` contains `@sha256:` + 64 hex; `rust`
     and `node` look like `x.y.z`. Also `bash -n` on `scripts/build-native.sh`,
     `scripts/native-in-container.sh` and `scripts/build-release.sh` exits 0.
   - `test/fixes.test.mjs`: new cases for the kvm `no access` fix, the bundled libkrun fix, and
     the Debian/Ubuntu source-checkout libkrun fix.
   - Update any existing test that asserts `microvm (system libkrun)` or the old libkrun texts.

10. Docs:
    - `docs/RELEASING.md`: the release now runs `scripts/build-native.sh` (podman, network; first
      build takes several minutes, later ones reuse `build/native` while `versions.json` and
      `vm/hive-vm.c` are unchanged); bumping a pin = edit `versions.json`; the GPL source assets
      and `HIVE_RELEASE_SKIP_SOURCES`; the file table gains `lib/libkrun.so.1`,
      `lib/libkrunfw.so.5`, `share/licenses/` and the two source tarballs.
    - `docs/THIRD-PARTY.md`: libkrun row: bundled in releases (built from source at the pinned
      tag), system libkrun preferred when it works; libkrunfw row: bundled, upstream prebuilt,
      corresponding source attached to each release; passt row: the system package, not bundled.
      Update the paragraph under the table accordingly.
    - `docs/CONFIGURATION.md`: `HIVE_LIBKRUN` row: default "system `libkrun.so.1` if it works, else
      the bundled one"; setting it forces that library.
    - `README.md` Requirements: release installs need only KVM and pasta (`sudo apt install passt`
      / `sudo dnf install passt` / `sudo pacman -S passt`); libkrun is bundled; building from
      source still needs the system libkrun (Fedora: `sudo dnf install libkrun passt`). Keep the
      Windows/macOS lines as they are.
    - `docs/HOW-IT-WORKS.md`: wherever it says libkrun comes from the system, say it's the system
      one when it works, else the bundled one.
    - `AGENTS.md`: layout table gains `versions.json`, `scripts/build-native.sh`,
      `scripts/native-in-container.sh`, `src/libkrun.ts`; build section mentions
      `scripts/build-native.sh` for release-grade native builds.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/libkrun.test.mjs test/versions.test.mjs test/fixes.test.mjs` exits 0 (after
  `npm run build`).
- `bash -n scripts/build-native.sh && bash -n scripts/native-in-container.sh && bash -n scripts/build-release.sh` exits 0.
- `grep -rn "microvm (system libkrun)" src/` prints nothing.
- `git status --short` lists no files other than those in **Files to touch**.
- Optional, once: if `podman` can be installed and run in this VM (`dnf install -y podman`, then
  `podman run --rm docker.io/library/alpine:3.20 true`), run `bash scripts/build-native.sh` and
  report its output (the checks' lines). If podman can't run here, say so in the report and do not
  work around it; the build is verified on the host afterwards.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never boot a hive VM, start `hive run`,
  start the server or call GitHub/OpenRouter APIs (plain downloads in `build-native.sh` are fine).
  If something outside Acceptance fails, note it in the report and finish.
- No new npm dependencies. Don't change `vm/hive-vm.c`, `image/` or `ui/`. Don't bundle pasta.
- Never mention pi-vm or dsh in docs or code.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- CI, the weekly pin-bump job, the beta channel, `PI_VERSION` in the pin file, macOS, gVisor,
  the WSL installer, publishing a release.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
