## Goal

**First-run onboarding in the web UI**, following "Screen 1" in `docs/GUI.md` (mockup:
https://claude.ai/artifact/7aZcD6LT5b12cG5VAzC1v7). A new user who opens the web UI on a machine
that isn't set up yet is walked through: **Welcome → Check this computer → Add a model key →
GitHub (optional) → Ready.** Every failed check shows the exact command that fixes it, for the
user's distro, and WSL gets its own advice. `hive doctor` prints the same fix commands.

## Files to touch

- `src/fixes.ts` (new)
- `src/sandbox.ts`
- `src/release.ts`
- `src/routes/onboarding.ts` (new)
- `src/routes/system.ts`
- `src/index.ts`
- `src/cli.ts`
- `ui/src/onboarding.ts` (new)
- `ui/src/main.ts`
- `ui/src/app.css`
- `test/fixes.test.mjs` (new)
- `test/onboarding.test.mjs` (new)
- `scripts/ui-smoke.mjs`
- `docs/GUI.md`
- `docs/SERVER.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. **Fix commands** (`src/fixes.ts`, new, pure functions):
   - `export interface HostInfo { distro: string; distroLike: string[]; wsl: boolean; bundle:
     boolean }` and `export function hostInfo(o?: { osRelease?: string; procVersion?: string;
     bundle?: boolean }): HostInfo`, parsing `/etc/os-release` (`ID`, `ID_LIKE`) and
     `/proc/version` (WSL when it contains `microsoft` or `WSL`, case-insensitive); the defaults
     read the real files (missing files → `distro: "unknown"`, `wsl: false`) and
     `bundle: bundleRoot() !== undefined`.
   - `export function fixFor(check: "kvm" | "libkrun" | "pasta" | "launcher" | "rootfs", host:
     HostInfo): { text: string; command?: string }`, where `text` is one plain sentence and
     `command` a single copyable command (or absent):
     - `kvm`: WSL → text says to turn on nested virtualization: in `%UserProfile%\.wslconfig` put
       `nestedVirtualization=true` under `[wsl2]`, then run `wsl --shutdown` in Windows (command:
       `wsl --shutdown`); otherwise → enable virtualization (Intel VT-x / AMD-V) in the BIOS or
       UEFI settings, or on a cloud VM pick a type with nested virtualization; no command.
     - `libkrun`: Fedora, RHEL, CentOS, Rocky, Alma (`ID` or `ID_LIKE` contains `fedora` or
       `rhel`) → command `sudo dnf install libkrun`; Debian/Ubuntu (`debian` or `ubuntu`) → text:
       libkrun isn't packaged for this distro yet; a bundled libkrun is planned, or use Fedora
       (and, on WSL, the Fedora WSL distro); other → text pointing at
       `https://github.com/containers/libkrun`.
     - `pasta`: dnf family → `sudo dnf install passt`; Debian/Ubuntu → `sudo apt install passt`;
       Arch (`arch`) → `sudo pacman -S passt`; other → text pointing at `https://passt.top`.
     - `launcher`: bundle → text: reinstall hive (command: the `curl … install-cli.sh | sh` line
       from `README.md`); source checkout → command `npm run build:vm`.
     - `rootfs`: bundle → command `hive setup` (the UI also offers a Download button); source
       checkout → command `npm run build:image && npm run build:rootfs`.

3. `src/sandbox.ts`: `SystemCheck` gains `id: "kvm" | "libkrun" | "pasta" | "launcher" | "rootfs"`
   and `fix?: { text: string; command?: string }`, set (from `fixFor` with `hostInfo()`) only on
   failed checks. Keep the existing `name`, `ok`, `detail`.

4. `src/release.ts`: `setupRootfs` gains an optional `onProgress?: (p: { received: number; total:
   number | undefined }) => void`, called as the rootfs archive downloads (thread it through
   `ensureRootfs`/`download` as needed; `total` from `Content-Length` when present). Keep the
   current behaviour when it's not given.

5. **Server** (`src/routes/onboarding.ts`, new; registered in the authenticated scope in
   `src/index.ts`):
   - `GET /api/onboarding` → `{ needed, checks (as in /api/system, with fixes), hasKey,
     defaultProvider, github: { connected, login? }, host: { distro, wsl, bundle }, rootfs: {
     ok, canDownload, download: { state: "idle" | "downloading" | "done" | "error", received,
     total, error? } } }`. `needed` is true when no provider has a key or any check fails.
     `canDownload` is true only for an installed release (`bundle`) whose rootfs is missing.
     Reuse `githubStatus()` from `src/routes/system.ts` (export it there).
   - `POST /api/setup/rootfs` → 409 `{ error }` when `canDownload` is false or a download is
     already running; otherwise start `setupRootfs({ onProgress })` in the background, keep its
     state in memory for the `download` field above, and respond 202 `{ state: "downloading" }`.

6. **CLI** (`src/cli.ts`): `hive doctor` prints, under each failed check, the fix `text` and, when
   present, `  $ <command>` (in the existing plain and TTY styles; in TTY mode the command in cyan).
   Passing checks are unchanged.

7. **Web UI** (`ui/src/onboarding.ts`, new module; keep `main.ts` changes to routing and a
   Settings link). A full-page flow at `#setup` with a step indicator (1–5) and Back / Next
   buttons, in the existing design (light and dark tokens, hexagon logo, cards, buttons):
   1. **Welcome:** what hive does, in three short points (runs a coding agent on your code in its
      own microVM; nothing secret goes in but one model key; you review everything before it
      reaches your repo or GitHub). Next.
   2. **Check this computer:** the checks from `GET /api/onboarding` as rows with ✓ / ✗. A failed
      check shows its fix text and, when present, the command in a `<code>` box with a **Copy**
      button (`navigator.clipboard.writeText`, with a "Copied" confirmation). When
      `rootfs.canDownload`, a **Download VM filesystem** button calls `POST /api/setup/rootfs` and
      shows a progress bar (`received/total`, polling `GET /api/onboarding` every second while
      `downloading`). **Check again** re-fetches. On WSL show one extra note that WSL needs nested
      virtualization and, for now, the Fedora WSL distro. Next is enabled even when checks fail
      (label it "Continue anyway" then), so a user can add a key first.
   3. **Add a model key:** if a key exists, say which provider is the default and offer Next;
      otherwise a provider select (from `GET /api/providers`), a password input for the key and a
      **Test and save** button using the existing `POST /api/keys` (it tests before saving); show
      the server's error inline on failure; after success show the provider's default model and a
      **Make default** option when other providers already have keys (`PUT /api/keys/default`).
   4. **GitHub (optional):** connected → "Signed in to GitHub as <login>": hive can list your
      repos, push branches and open pull requests. Not connected → explain it's optional (local
      repos and the terminal still work) and show `gh auth login` in a copy box, with **Check
      again**. **Skip** and Next.
   5. **Ready:** a short summary (checks passed or not, key provider, GitHub) and two actions:
      **Start your first run** (goes to `#runs` and focuses the task box) and the terminal
      equivalents in a copy box (`hive run "<task>"` from inside a repo).
   - **When it shows:** on login, `main.ts` fetches `GET /api/onboarding`; when `needed` is true
     and the browser hasn't dismissed it (`localStorage` key `hive-onboarding-done`, read and
     written in `try`/`catch`), go to `#setup`. Finishing or skipping (a **Skip setup** link on
     every step) sets that key. Settings gets a **Run setup again** link to `#setup`.
   - Render everything from the server with `el()` / `esc()` only (security rule #4 in
     `AGENTS.md`); no `innerHTML` with server text.

8. Tests:
   - `test/fixes.test.mjs` (new): `hostInfo` on sample `os-release` / `proc/version` strings
     (Fedora, Ubuntu, Rocky via `ID_LIKE`, WSL detection, missing input); `fixFor` for each check
     on Fedora, Ubuntu, WSL and bundle vs source, checking the command strings above.
   - `test/onboarding.test.mjs` (new): a bare Fastify app with the plugin (temp `HIVE_KEYS_FILE`,
     no keys) → `GET /api/onboarding` has `needed: true` and `hasKey: false`; with a provider key
     in the env → `hasKey: true`; `POST /api/setup/rootfs` from a source checkout → 409.
   - `scripts/ui-smoke.mjs`: add a section that mocks `GET /api/onboarding` (needed, one failed
     check with a fix command, `canDownload: true`) and `POST /api/setup/rootfs`, clears the
     `hive-onboarding-done` key, logs in, and walks Welcome → Checks (the fix command is visible,
     the Download button exists) → Key → GitHub → Ready → **Start your first run** lands on the
     Runs page; save a screenshot of the checks step.

9. Docs: `docs/GUI.md` — move the first-run screens from "Not built" to built, describe what's
   built. `docs/SERVER.md` — a short "First run" paragraph and the two new API endpoints in the
   API table.

## Acceptance

- `npm run build` exits 0.
- `npm run build:ui` exits 0.
- `npm test` exits 0.
- `node --test test/fixes.test.mjs test/onboarding.test.mjs` exits 0 (after `npm run build`).
- `npm i --no-save playwright-core@1.49.1 && node scripts/ui-smoke.mjs` exits 0 (it starts its
  own server on a test port with temp files, as it already does; system Chromium at
  `/usr/lib64/chromium-browser/chromium-browser`).
- `git status --short` lists no files other than those in **Files to touch** (plus files the smoke
  test writes and cleans up itself).

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands; the smoke test is the one server this
  plan runs. Never boot a hive VM, start `hive run`, download a real rootfs, or call
  GitHub/OpenRouter. If something outside Acceptance fails, note it in the report and finish.
- No new npm dependencies. Don't change `vm/`, `image/`, `src/runs.ts` or `src/web-runs.ts`.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Onboarding in the terminal (beyond `hive doctor`'s fixes), installing packages for the user,
  a bundled libkrun, WSL testing on Windows.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
