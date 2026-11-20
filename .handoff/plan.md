## Goal

Give the CLI run engine (`src/runs.ts`) pi-vm's run protections:

- a stall watchdog: stop a run when no file in its `work/` folder changed and no agent event arrived
  for `config.sandbox.stallMin` minutes (already in `src/config.ts`, env `HIVE_STALL_MIN`, default
  15, 0 = off);
- keep committed work when a run times out, stalls, fails or is stopped: always run the export step
  (unless the run never got a `work/` folder);
- read success from pi's last assistant message: a run whose agent exited 0 but whose last
  assistant `message_end` has `stopReason` `"error"` or `"aborted"` is `failed`;
- mount the shared VM cache `config.sandbox.vmCache` (already in `src/config.ts`) at `/root/.cache`.

## Files to touch

- `src/stall.ts` (new)
- `src/runs.ts`
- `test/stall.test.mjs` (new)
- `test/run-status.test.mjs` (new)
- `README.md`
- `.env.example`
- `.handoff/report.md`

## Steps

1. Run `npm ci`.

2. `src/stall.ts` (new), ESM TypeScript like the rest of `src/`:
   - `export async function changedWithin(dir: string, minutes: number): Promise<boolean>`: runs
     `find <dir> -mmin -<minutes> -print -quit` with `execFile` (promisified, `timeout:
     60_000`); returns `true` when stdout is non-empty. If `find` fails, return `true` (never stop a
     run because the check itself failed).
   - `export function startStallWatch(o: { dir: string; stallMin: number; lastActivity: () => number;
     onStall: () => void; intervalMs?: number }): { stop(): void }`: if `o.stallMin <= 0` return a
     no-op `{ stop() {} }`. Otherwise every `o.intervalMs ?? 60_000` ms: if
     `Date.now() - o.lastActivity() >= o.stallMin * 60_000` and `!(await changedWithin(o.dir,
     o.stallMin))`, call `o.onStall()` once and stop the timer. Never run two checks at once. Call
     `.unref()` on the timer.

3. `src/runs.ts`:
   - Add `export function finalStatus(r: { aborted: boolean; timedOut: boolean; stalled: boolean;
     code: number | null; stopReason?: string; modelError?: string; stderr: string; timeoutMin:
     number; stallMin: number }): { status: RunStatus; error?: string }` with this order:
     1. `aborted` → `{ status: "aborted" }`
     2. `stalled` → `failed`, error `stalled: nothing changed for <stallMin> minutes`
     3. `timedOut` → `failed`, error `timed out after <timeoutMin> minutes`
     4. `code !== 0` → `failed`, error `agent exited <code>: ` + last 2000 chars of `stderr`
     5. `stopReason` is `"error"` or `"aborted"` → `failed`, error `model error: ` + (`modelError`
        or `stopReason`)
     6. otherwise `{ status: "done" }`
   - In the run function (the code around `runSandbox` / `followJsonl` near the end of the file):
     - Add the mount `{ host: config.sandbox.vmCache, container: "/root/.cache", shared: true }`
       when `config.sandbox.vmCache` is non-empty, after `mkdirSync(..., { recursive: true })`, next
       to the existing npm cache mount.
     - Keep `let lastActivity = Date.now()`; set it to `Date.now()` in the `followJsonl` callback.
       In the same callback, for `e.type === "message_end"` with `e.message.role === "assistant"`,
       record `stopReason = e.message.stopReason` and `modelError = e.message.errorMessage`.
     - Start `startStallWatch({ dir: join(dir, "work"), stallMin: config.sandbox.stallMin,
       lastActivity: () => lastActivity, onStall: () => { stalled = true; void handle.stop(); } })`
       right after `followJsonl`; stop it right after `await handle.done`.
     - Replace the existing status/error block with a call to `finalStatus` (stderr text as today:
       `io/stderr.log`, falling back to `result.stderr`).
     - Run the export step whenever `existsSync(join(dir, "work"))`, whatever the status. On export
       success set `meta.commits = patchFiles(dir).length` but keep the status and error from
       `finalStatus`. On export failure: if the status was `done`, set `failed` with
       `export failed (exit <code>)`; otherwise append `; export failed (exit <code>)` to the error.
   - Don't change anything else in `src/runs.ts`.

4. `test/stall.test.mjs` (new), style like `test/follow.test.mjs` (import from `../dist/stall.js`,
   temp dirs from `os.tmpdir()`):
   - `changedWithin` returns `true` for a dir with a file just written, and `false` after setting
     that file's and the dir's mtime 30 minutes back (`utimesSync`) and asking for 15 minutes.
   - `startStallWatch` with `stallMin: 0` never calls `onStall`.
   - `startStallWatch` with `intervalMs: 50`, `stallMin: 15`, `lastActivity: () => Date.now() -
     20 * 60_000` and an old dir (mtimes 30 minutes back) calls `onStall` exactly once within 2 s.
   - The same with `lastActivity: () => Date.now()` does not call `onStall` within 500 ms.
   - Stop every watch in the test.

5. `test/run-status.test.mjs` (new): import `finalStatus` from `../dist/runs.js` and check one case
   per rule in step 3, plus that `aborted` wins over `stalled` and `stalled` wins over `timedOut`.

6. `README.md`: where the CLI's run settings or limits are described, add `HIVE_STALL_MIN`
   (default 15, 0 off), `HIVE_VM_CACHE`, that VMs default to 2 GB and 2 CPUs
   (`HIVE_SANDBOX_MEMORY`, `HIVE_SANDBOX_CPUS`), and that committed work is kept when a run times
   out, stalls or is stopped. `.env.example`: add `HIVE_STALL_MIN` and `HIVE_VM_CACHE` commented
   out, next to the other `HIVE_SANDBOX_*` lines, and fix the memory/CPU defaults shown there if
   any.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/stall.test.mjs test/run-status.test.mjs` exits 0 (after `npm run build`).
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never boot a VM, start `hive run`, or
  start the server. If something outside Acceptance fails, note it in the report and finish.
- Don't touch `src/tasks.ts`, `src/server.ts`, `src/routes/`, `ui/`, `vm/` or `image/`. No new
  dependencies.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- The server engine (`src/tasks.ts`) and the web UI.
- Filtering `message_update` events, the VM image, OpenRouter routing.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
