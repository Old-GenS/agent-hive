## Goal

Before merging the CLI and server engines (`docs/CORE.md`), remove the server parts nothing uses,
and fix two UI details:

1. **Remove:** the podman sandbox backends (krun, gVisor/runsc, crun/runc), the `/snippet`,
   `/files`, `/file` and `/messages` routes, `/api/github/search`, `/api/github/fork`, and the old
   landing page (`/` and `/docs` now redirect to `/ui/`). libkrun is the only backend.
2. **Run timer:** the bee's elapsed timer restarts at 0:00 when you switch pages or reopen a run. It
   must show the real time since the current step started, and a finished run's real duration.
3. **Settings › This computer:** a live "Right now" section with CPU use, memory, free disk space
   for runs, CPU temperature (when the machine reports one) and runs in progress, refreshed every
   5 seconds while the page is open.

## Files to touch

- `src/sandbox.ts`
- `src/config.ts`
- `src/index.ts`
- `src/routes/sessions.ts`
- `src/routes/github.ts`
- `src/routes/system.ts`
- `src/tasks.ts`
- `src/usage.ts` (new)
- `public/landing.html` (delete; delete `public/` if it is then empty)
- `ui/src/main.ts`
- `ui/src/bee.ts`
- `ui/src/app.css`
- `ui/vite.config.ts`
- `scripts/ui-smoke.mjs`
- `test/*.test.mjs` (only to remove or adjust tests for removed code)
- `test/usage.test.mjs` (new)
- `README.md`, `AGENTS.md`, `.env.example`
- `.handoff/report.md`, `.handoff/ui-*.png`

## Steps

1. Run `npm ci`, then `cd ui && npm ci && cd ..`, then `bash vm/build.sh`.

2. **Remove the podman backends** (`src/sandbox.ts`, `src/config.ts`):
   - Delete `spawnPodman`, the podman branches of `runSandbox`'s `stop`, the podman part of
     `checkSandbox` and `systemInfo`, `CONTAINER_WARNING`, and krun/runsc/crun/runc detection.
   - `detectRuntime()` returns `{ runtime: "libkrun", isolation: "microvm" }` when
     `libkrunAvailable()`, else `{ runtime: "libkrun", isolation: "unavailable", warning: "<what is missing, from checkSandbox()>" }`
     (add `"unavailable"` to the `Isolation` type; remove `"gvisor"` and `"container"`).
   - `HIVE_RUNTIME`: accept only `auto` or `libkrun` (anything else: the existing kind of error,
     listing `auto, libkrun`). Remove `config.sandbox.image` and `HIVE_IMAGE` from runtime code (the
     image name stays only in `package.json`'s `build:image` script and `vm/build-rootfs.sh`).
   - `runSandbox` always uses the libkrun path. `ioDir` becomes required in `SandboxOptions` (every
     caller already passes it or must: give the export sandbox its own `io` dir as today); remove
     the stdout JSONL parsing so events only come from `io/events.jsonl`. Keep `onEvent`.
   - `src/cli.ts` already forces libkrun; only adjust it if it referenced removed names.
   - Keep `vm/`, `image/` and the `build:image` / `build:rootfs` scripts: podman is still used once to
     build the VM filesystem.

3. **Remove unused routes:**
   - `src/routes/sessions.ts`: delete `POST /snippet`, `GET /files/:sessionId`, `GET /file/:sessionId`,
     `GET /messages/:sessionId` and the helpers only they use (`insideWork`, etc.). Keep
     `DELETE /session/:sessionId`.
   - `src/routes/github.ts`: delete `GET /api/github/search` and `POST /api/github/fork`.
   - `src/tasks.ts`: remove the `ephemeral` option and its uses (only `/snippet` used it).
   - `src/index.ts`: delete the `public/` static registration and the landing routes; add
     `app.get("/", (_req, reply) => reply.redirect("/ui/"))` and the same for `/docs`. Delete
     `public/landing.html`.
   - `ui/vite.config.ts`: drop proxy entries for removed paths (`/messages`, `/system-prompt`, …);
     add `/runs` and `/session`.

4. **Run timer** (`src/tasks.ts`, `ui/src/bee.ts`, `ui/src/main.ts`):
   - `Task` gets `stepStartedAt?: number` (set to `Date.now()` when `runPrompt` starts a prompt,
     before queueing) and `finishedAt?: number` (set when the prompt ends: idle, failed or aborted;
     cleared when a new prompt starts). `toJSON()` includes both. Add `stepStartedAt` and
     `finishedAt` to the `hive_done` events too.
   - `createBeeIndicator()` / `set()`: `set(state, label, times?: { startedAt?: number; endedAt?: number })`.
     When `startedAt` is given, the timer counts from it (not from the first `set` call); when
     `endedAt` is given, the timer shows `endedAt - startedAt` and stops. Without times, keep today's
     behaviour.
   - The UI passes `stepStartedAt` (and `finishedAt` when done) from `/status` when it opens a run,
     from `/runs` entries, and from `hive_done`; a run started from the form uses the time `/prompt`
     returned. Switching pages or reloading must show the same elapsed time as before the switch.
   - The run list's elapsed time for busy runs uses `stepStartedAt` too.

5. **Live usage** (`src/usage.ts` new, `src/routes/system.ts`):
   - `export async function usageNow(o?: { sysRoot?: string; diskPath?: string }): Promise<Usage>` with
     ```ts
     interface Usage {
       cpu: { percent: number; cores: number; load1: number };
       memory: { usedBytes: number; totalBytes: number };
       disk: { path: string; freeBytes: number; totalBytes: number };
       temperature: { celsius: number; sensor: string } | null;
     }
     ```
     - CPU percent: two `os.cpus()` samples 250 ms apart; busy share of all cores, 0–100, one
       decimal. `load1` from `os.loadavg()[0]`.
     - Memory: total from `os.totalmem()`; used = total − `MemAvailable` from `<sysRoot>/proc/meminfo`
       (fall back to `os.freemem()`).
     - Disk: `fs.statfsSync(diskPath)` for `diskPath` = the folder runs live in
       (`config.workspace`, creating it if missing); free = `bavail * bsize`, total = `blocks * bsize`.
     - Temperature: first of `<sysRoot>/sys/class/hwmon/hwmon*/` whose `name` is `coretemp`,
       `k10temp`, `zenpower` or `cpu_thermal`, reading `temp1_input` (millidegrees); else the
       `<sysRoot>/sys/class/thermal/thermal_zone*` whose `type` is `x86_pkg_temp`; else `null`.
       `sensor` is that name/type. `sysRoot` defaults to `/` (tests pass a fake tree).
   - `GET /api/system/usage` (authenticated, in `src/routes/system.ts`) returns `usageNow()` plus
     `runs: capacity()`.

6. **This computer UI** (`ui/src/main.ts`, `ui/src/app.css`): a "Right now" section between the
   isolation card and GitHub: five tiles in a responsive grid (two columns on phones), each with a
   label, a big value and a thin bar where it makes sense:
   - **CPU**: `37%` and `4 cores · load 1.2`, bar = percent;
   - **Memory**: `2.4 of 7.6 GB`, bar = used share;
   - **Disk free**: `220 GB free of 236 GB` (for the runs folder), bar = used share;
   - **CPU temperature**: `58 °C` (`coretemp`), or "Not reported" when null; no bar;
   - **Runs**: `1 running · 0 queued` of `3`.
   Bars use `--accent`, turning `--warn` at 75% and `--danger` at 90% (temperature value turns warn
   at 80 °C and danger at 90 °C). Fetch `/api/system/usage` when the page opens and every 5 seconds
   while it is open and visible; stop when leaving the page. Text only via `el()`/`textContent`.
   Give the section `id="usageSection"`.

7. `scripts/ui-smoke.mjs`: keep every existing check (remove only checks for removed features, if
   any). On This computer, wait for `#usageSection` and assert it has five tiles and the CPU tile's
   value matches `/^\d+(\.\d)?%$/`. In the faked run-list check, give list-b a
   `stepStartedAt: Date.now() - 300000` and `finishedAt: Date.now() - 240000` and assert the bee
   time for the reopened run reads `1:00`.

8. **Tests:** remove tests that only cover removed code (podman command building, snippet,
   files); keep everything else passing. `test/usage.test.mjs` (new): build a fake tree in a temp dir
   with `proc/meminfo` (`MemAvailable: 2097152 kB`) and `sys/class/hwmon/hwmon3/name` = `coretemp`,
   `temp1_input` = `58000`; `usageNow({ sysRoot, diskPath: tmp })` returns `temperature`
   `{ celsius: 58, sensor: "coretemp" }`, `memory.usedBytes === os.totalmem() - 2097152 * 1024`,
   `cpu.cores === os.cpus().length`, `0 <= cpu.percent <= 100`, and `disk.totalBytes > 0`; a tree
   with only `sys/class/thermal/thermal_zone0/type` = `x86_pkg_temp` and `temp` = `61000` gives
   61 °C; an empty tree gives `temperature: null`.

9. **Docs:** README and AGENTS.md: remove the podman backends, the removed routes and the landing
   page; `HIVE_RUNTIME` is `auto` or `libkrun`; machines need KVM (the roadmap's gVisor step will
   cover the rest); note that the separate hive-mcp package no longer works (a built-in `hive mcp`
   is planned); add `/api/system/usage` and the "Right now" section. `.env.example`: drop the
   podman/runtime comments that no longer apply.

## Acceptance

- `npm test` exits 0 and includes `test/usage.test.mjs` passing.
- `npm run build:ui` exits 0.
- `npm i --no-save playwright-core@1.49.1 && node scripts/ui-smoke.mjs` prints `ui-smoke: ok`.
- `grep -rnE "spawnPodman|runsc|/snippet|github/fork|landing.html" src ui/src` prints nothing.
- `test -e public/landing.html` exits 1.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never start the real server outside the
  smoke script, never let a script reach the real `/prompt`. If something outside Acceptance fails,
  note it in the report and finish.
- No behaviour change for anything that is kept (runs, PRs, issues, new projects, keys, run list,
  review cycles). Every route stays authenticated except `/health` and the redirects.
- No new dependencies, no emoji.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- The engine merge itself (`docs/CORE.md` stages 1–3), the tray app, run retention.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
