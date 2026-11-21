## Goal

Ship a static pasta in the release as a **fallback** for distros with no `passt` package (Ubuntu
22.04 / Mint 21, Debian 11, RHEL 8). The system pasta stays first: Ubuntu 24.04+ only allows the
user namespace pasta needs under the AppArmor profile its `passt` package installs, and the system
copy gets distro security updates. Same structure as the bundled libkrun (`src/libkrun.ts`,
`versions.json`, `scripts/build-native.sh`).

## Files to touch

- `versions.json`
- `scripts/build-native.sh`, `scripts/native-in-container.sh`, `scripts/build-release.sh`
- `src/pasta.ts` (new)
- `src/sandbox.ts`, `src/cli.ts`, `src/fixes.ts`
- `test/pasta.test.mjs` (new), `test/versions.test.mjs`, `test/sandbox.test.mjs`,
  `test/fixes.test.mjs`
- `docs/RELEASING.md`, `docs/THIRD-PARTY.md`, `docs/ROADMAP.md`, `README.md`, `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `versions.json`: add
   ```json
   "passt": {
     "version": "2026_10_02.cba3570",
     "url": "https://passt.top/passt/snapshot/passt-2026_10_02.cba3570.tar.xz",
     "sha256": "aa75616cc43925f0bd6c05bcfbbaecd77397c03d7bd23591b34ef535be5dfcdc"
   }
   ```
   (The tarball's top directory is `passt-2026_10_02.cba3570/`; licenses are in its `LICENSES/`:
   `BSD-3-Clause.txt`, `GPL-2.0-or-later.txt`.)

3. Native build:
   - `scripts/build-native.sh`: read the three `passt` pins; download the tarball on the host,
     verify its SHA-256 (clear error on mismatch), and mount it read-only into the container (or
     pass it in the output-dir mount) for `native-in-container.sh`; copy `LICENSES/*` into
     `build/native/share/licenses/passt/`. Output gains `libexec/pasta`.
   - `scripts/native-in-container.sh`: extract the tarball to `/tmp/passt`, run
     `make -C /tmp/passt static` (it builds `pasta` and `passt` with `-static`), copy
     `/tmp/passt/pasta` to `/out/libexec/pasta`, `strip` it. Checks (fail with a message): `file`
     or `readelf -d` shows it is **statically linked** (no `NEEDED` entries, no `INTERP` program
     header); `/out/libexec/pasta --version` exits 0 and prints the pinned version string
     somewhere in its output (warn instead of fail if the version text doesn't match).
   - `scripts/build-release.sh`: copy `build/native/libexec/pasta` into `$app/libexec/pasta` and
     `share/licenses/passt/`. GPL source: unless `HIVE_RELEASE_SKIP_SOURCES=1`, copy the verified
     passt tarball to `$out/passt-<version>-source.tar.xz` and add it to `SHA256SUMS` (next to the
     libkrunfw source lines).

4. `src/pasta.ts` (new), mirroring `src/libkrun.ts`:
   - `export type PastaSource = "system" | "bundled";`
   - `export function pastaCandidates(bundle: string | undefined, onPath: (cmd: string) => string |
     undefined, exists = existsSync): { path: string; source: PastaSource }[]` — the system pasta
     (absolute path from `onPath("pasta")`) when found, then `<bundle>/libexec/pasta` when the
     bundle is set and the file exists.
   - `export function pickPasta(candidates, works: (path) => boolean)` — first that works, `ok:
     true`; none → first candidate (or `{ path: "pasta", source: "system" }` when the list is
     empty) with `ok: false`.
   - `export function pastaChoice()` — memoized like `libkrunChoice()` (keep a working choice,
     re-probe a failed one). `works(path)` = `spawnSync(path, ["--version"], { timeout: 5000 })`
     exits 0. `onPath` = search `PATH` for an executable `pasta` (reuse or move the existing helper
     in `src/sandbox.ts` / `commandPath` in `src/cli.ts`; one implementation).
   - `export function pastaLabel(c)`: `"system pasta"` / `"bundled pasta"`.

5. Use it:
   - `src/sandbox.ts`: `buildLibkrunCommand` returns `{ file: <pasta path>, args }` — add an
     optional `pastaBin?: string` to its `p` argument (default `"pasta"`, so existing tests keep
     passing); `runSandbox` passes `pastaChoice().path`. `pastaSupports()` probes the chosen
     binary, not `pasta` from PATH. `libkrunAvailable()` and the system check use
     `pastaChoice().ok` instead of `onPath("pasta")`; the pasta check `detail` becomes
     `<label> (<path>): <existing network text>` when ok.
   - `src/cli.ts` doctor: the pasta line `ok (<label>: <path>)` when ok, `not found` otherwise.
   - `src/fixes.ts` `"pasta"`: when `host.bundle` is true and the check failed, the text says the
     bundled pasta couldn't run and the distro's package fixes it (keep the per-distro install
     commands as the `command`); unchanged otherwise.

6. Tests:
   - `test/pasta.test.mjs` (new): candidates (system only; system + bundled; bundled only when no
     system pasta; bundle set but file missing), `pickPasta` (system works; system broken →
     bundled; none → ok false; empty list → `pasta`/system/ok false), labels.
   - `test/versions.test.mjs`: `passt.sha256` is 64 hex, `passt.url` starts with
     `https://passt.top/passt/snapshot/passt-` and contains `passt.version`.
   - `test/sandbox.test.mjs`: `buildLibkrunCommand` with `pastaBin: "/b/libexec/pasta"` returns
     that as `file`.
   - `test/fixes.test.mjs`: the bundled-pasta fix text.

7. Docs:
   - `README.md` Requirements: pasta comes from the distro's `passt` package when it has one; a
     bundled copy covers distros without (Ubuntu 22.04, Debian 11, RHEL 8).
   - `docs/THIRD-PARTY.md` passt row: system package preferred, static build bundled as a fallback,
     source attached to each release (GPL-2.0-or-later, BSD-3-Clause).
   - `docs/RELEASING.md`: the passt pin, the static build check, the source asset.
   - `docs/ROADMAP.md` step 2: replace "pasta stays a system package ... not bundled" with: system
     pasta first (AppArmor profile, updates), bundled static pasta as the fallback for distros
     without a package.
   - `AGENTS.md`: layout row for `src/pasta.ts`.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/pasta.test.mjs test/versions.test.mjs test/sandbox.test.mjs test/fixes.test.mjs` exits 0 (after `npm run build`).
- `bash -n scripts/build-native.sh && bash -n scripts/native-in-container.sh && bash -n scripts/build-release.sh` exits 0.
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
  VM); never boot a hive VM, start `hive run`, start the server or call GitHub/OpenRouter. If
  something outside Acceptance fails, note it in the report and finish.
- No new npm dependencies. Don't change `vm/`, `image/` or `ui/`.
- Never mention pi-vm or dsh in docs or code.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- CI, update automation, the beta channel, macOS.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
