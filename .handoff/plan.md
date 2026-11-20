## Goal

Bring the web UI back to feature parity with the deleted server engine, with every feature living in
the CLI run engine (`src/runs.ts`): follow-ups, review cycles, new projects, a run queue, the
"cloning" step and a per-run system prompt. The deleted engine is readable with
`git show 9cce3c2^:src/tasks.ts` (see `runPrompt`, `runAgent`, `exportAndPush`, `REVIEW_PROMPT`);
the web routes are in `src/web-runs.ts`. The UI (`ui/`) must not need changes: it already sends
`sessionId`, `reviewCycles`, `reviewModel`, `newRepo`, `systemPromptOverride` and reads
`hive_status` (`queued` with `running`/`max`, `cloning` with `newProject`, `running`,
`reviewing` with `cycle`/`of`, `pushing`) and `hive_done` (`createdRepo`, `commitsPushed`,
`resultBranch`, `repoSlug`, `changes`, `status`, `error`).

## Files to touch

- `src/runs.ts`
- `src/web-runs.ts`
- `src/cli.ts`
- `test/web-runs.test.mjs`
- `test/run-steps.test.mjs` (new)
- `README.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `src/runs.ts`, run data:
   - `RunStatus` gains `"queued"`. `RunMeta.source` becomes `"local" | "remote" | "new"`. Add to
     `RunMeta`: `newRepo?: { name: string; private: boolean }`, `createdRepo?: string`,
     `reviewCycles?: number`, `reviewModel?: string`, `steps?: number` (agent steps run so far).
   - `StartRunOptions` gains: `newRepo?: { name: string; private?: boolean }` (a third source:
     exactly one of `repo`, `remote`, `newRepo` must be set, else throw `"startRun needs exactly one
     of repo, remote or newRepo"`; validate the name with `validateRepoName` before anything else
     happens), `systemPrompt?: string`, `reviewCycles?: number` (integer 0..5, else throw),
     `reviewModel?: string`, `onStatus?: (status: string, extra?: Record<string, unknown>) => void`,
     `waitTurn?: (signal: AbortSignal) => Promise<void>`.

3. `src/runs.ts`, `startRun` order:
   1. validate (as today, plus step 2);
   2. `makeRunDir(...)` (name: the new repo's name for `newRepo`), write `meta.json` with
      `status: "queued"`, `base: ""`, `pid: process.pid` and the new fields, then call `o.onStart`;
   3. `await o.waitTurn?.(o.signal)`; if `o.signal.aborted` afterwards (or `waitTurn` rejects
      because of the abort), set `status: "aborted"`, `finishedAt`, write meta and return;
   4. `o.onStatus?.("cloning", newRepo ? { newProject: true } : {})`, then prepare:
      `prepareNewRepo(dir)` for `newRepo`, `prepareRepo` for `remote`, `prepareLocal` for `repo`;
      set `meta.base`, `meta.status = "running"`, write meta;
   5. write `io/system.md` with `o.systemPrompt || config.systemPrompt`;
   6. call `runSteps(dir, meta, prompt, { continueSession: false, ... })` (step 4) and return
      `{ dir, meta }`.
   For `newRepo` runs, prefix the prompt with: `/work is an empty git repository for a new project.
   Create the project there and commit your work with clear messages. You cannot push; when you
   finish, hive creates the GitHub repository <name> and pushes your commits to it.\n\n`.

4. `src/runs.ts`, a shared `async function runSteps(dir, meta, prompt, o)` used by `startRun` and
   `continueRun`:
   - **Agent step:** move today's VM/follow/stall/`finalStatus` code into
     `agentStep(dir, meta, { prompt, model, session: "new" | "continue" | "none", signal, onEvent })`
     returning `{ status, error, summary?, lastText }`. Before each step after the first in a run
     (`meta.steps >= 1`), rename `io/events.jsonl` to `io/events-<meta.steps>.jsonl` and
     `io/stderr.log` to `io/stderr-<meta.steps>.log` so earlier steps' events are kept; then
     increment `meta.steps`. Write the prompt to `io/prompt.md` as today. pi arguments:
     `session: "new"` → `--session-dir /session`; `"continue"` → `--session-dir /session --continue`;
     `"none"` → `--no-session` (no `/session` mount needed but keeping it is fine).
   - Run the main agent step with `o.onStatus?.("running")`, the run's model and
     `session: o.continueSession ? "continue" : "new"`. Save its summary to `meta.summary`.
   - **Review cycles:** if the main step's status is `done` and `meta.reviewCycles > 0`, for
     `i = 1..cycles`: `o.onStatus?.("reviewing", { cycle: i, of: cycles })`, run an agent step with
     `export const REVIEW_PROMPT` (copied verbatim from the deleted `src/tasks.ts`) for the
     original prompt and `meta.base`, model `meta.reviewModel || meta.model`, `session: "none"`.
     Stop when `isLgtm(lastText)` (`export function isLgtm(text: string): boolean` =
     `/^\s*LGTM\b/i.test(text)`) or when the review step's status isn't `done` (that status and
     error become the run's). Review steps don't overwrite `meta.summary`.
   - **Export:** as today (whenever `work/` exists), but first empty `out/` (`rmSync` + `mkdirSync`),
     because a follow-up exports the run's whole history again.
   - Write the final `status`, `error`, `commits`, `finishedAt` to meta and return.
   - Usage from every step is added to `meta.usage` (as today, via the events).

5. `src/runs.ts`, `export async function continueRun(dir, o: { prompt: string; signal: AbortSignal;
   onEvent; onStatus?; waitTurn? })`: throw `"run is still going"` when `isLive(meta)`;
   throw `"run has no work folder"` when `work/` is missing. Set `status: "queued"`, `pid`, clear
   `error`/`finishedAt`, write meta, `await o.waitTurn?.(o.signal)` (abort handling as in step 3),
   set `status: "running"`, then `runSteps(dir, meta, o.prompt, { continueSession: true, ... })`.
   Return `{ dir, meta }`.

6. `src/runs.ts`, publishing:
   - `pushRun(dir, o)` gains `update?: boolean`. When `update` and `meta.pushed` is set: push to
     `meta.pushed.branch` with `applyAndPush(dir, meta.base, meta.pushed.branch, true)` (the branch
     is the run's own), skipping the "branch already exists" check; update `meta.pushed.at`.
   - When `meta.source === "new"`: if `meta.commits === 0` return `{ branch: "main", url: "",
     commits: 0 }` without creating anything; otherwise, if `!meta.createdRepo`,
     `createGithubRepo(meta.newRepo.name, meta.newRepo.private)` → slug, `url =
     normalizeRepo(slug).url`, `git remote add origin <url>` in `<dir>/origin`, store
     `meta.createdRepo`; then `applyAndPush(dir, meta.base, "main", true)` and
     `meta.pushed = { branch: "main", url, at }`.

7. `src/web-runs.ts`:
   - **Queue:** `export function createSlots(max: number)` returning `{ acquire(signal):
     Promise<void>; release(): void; running(): number; queued(): number }`, FIFO; an aborted waiter
     leaves the queue and its promise rejects. One instance with `config.maxConcurrent`. Pass
     `waitTurn` to `startRun`/`continueRun`: if no slot is free, publish
     `{ type: "hive_status", status: "queued", running, max }` before waiting. Release the slot
     exactly once when the run ends (success, failure or abort, also when aborted while queued).
     Remove the 503 "All worker bees are busy" response. `GET /runs` and `/capacity` report the
     real `running` and `queued` counts.
   - `onStatus` → `publish(id, { type: "hive_status", status, ...extra })`.
   - `POST /prompt` with `sessionId`: 404 for an unknown run, 409 `{ error: "Session is still
     going; wait for it to finish or abort it" }` when live; otherwise register the live entry,
     start `continueRun` without awaiting it and respond `{ sessionId, status: "queued" |
     "running", repo, stepStartedAt, finishedAt: undefined }`. When it ends, `finishRun` pushes
     with `pushRun(dir, { update: true })`.
   - `POST /prompt` new run: remove the three "not supported yet" 400s. `newRepo` → `startRun({
     newRepo: { name, private: body.newRepo.private ?? true }, ... })` (no `repo` needed; `repo`
     and `newRepo` together → 400 `{ error: "Send repo or newRepo, not both" }`; neither → 400
     `"Pick a repository"`). Pass `systemPrompt: body.systemPromptOverride`, `reviewCycles`,
     `reviewModel`. Respond once `onStart` fires (the run may still be queued; status is then
     `"queued"`), and include `newRepo: body.newRepo?.name`.
   - `finishRun`: push when `meta.status === "done" && meta.commits > 0` (with `update: true` when
     `meta.pushed` is already set); for `source: "new"` with 0 commits don't push. Change summary
     as today.
   - `runToJSON` adds `createdRepo: meta.createdRepo`, `newRepo: meta.newRepo?.name`,
     `repoSlug` from `meta.createdRepo ?? meta.pushed?.url ?? meta.repo`; `uiStatus` maps a live
     run whose meta status is `queued` to `"queued"`.
   - The finished-run websocket replay sends `io/events-<n>.jsonl` files in numeric order, then
     `io/events.jsonl`, then the `hive_done`.

8. `src/cli.ts`: add `hive continue [run] <prompt>` (the run defaults to the latest, like
   `hive log`, via `resolveRun`), rendering events like `hive run` does and leaving pushing to
   `hive push` (for a run that was already pushed, `hive push` updates its branch: pass
   `update: true` when `meta.pushed` is set). Add `--review <n>` and `--review-model <model>` to
   `hive run`. Add both to the CLI's help text.

9. Tests:
   - `test/run-steps.test.mjs` (new): `isLgtm` cases (`"LGTM"`, `"  lgtm\nok"` true; `"Not LGTM"`,
     `""` false); `REVIEW_PROMPT("task", "abc123")` contains `task` and `abc123`; `startRun` with
     two sources or none rejects with the step-2 message; `startRun` with `newRepo: { name: "bad
     name" }` rejects with the `validateRepoName` message; `startRun` with `reviewCycles: 9`
     rejects. Use a temp `HIVE_RUNS_DIR`, `HIVE_KEYS_FILE` and `HIVE_DOTENV_PATH` set before
     importing `../dist/`, like `test/web-runs.test.mjs`, and a fake provider key in the env if
     validation needs one. No VM is booted by these cases.
   - `test/web-runs.test.mjs`: update the old "not supported yet" assertions: `newRepo` with
     `repo` → 400; follow-up for an unknown id → 404. Add `createSlots` tests: two acquires with
     `max: 1` (the second waits until `release()`), FIFO order, an aborted waiter rejects and
     leaves `queued()` at 0.

10. `README.md`: the web UI section no longer says follow-ups, review cycles and new projects are
    missing; document `hive continue`, `hive run --review`/`--review-model`, and that runs wait in
    a queue when `MAX_CONCURRENT_SESSIONS` runs are going.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/run-steps.test.mjs test/web-runs.test.mjs` exits 0 (after `npm run build`).
- `grep -n "supported yet" src/web-runs.ts` prints nothing.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never boot a VM, start `hive run`, start
  the server, or call `gh`/GitHub. If something outside Acceptance fails, note it in the report and
  finish.
- Don't change `ui/`, `vm/`, `image/`, `src/sandbox.ts` or `src/stall.ts`. Keep the stall
  watchdog, `finalStatus`, the shared caches and export-on-failure behaviour exactly as they are.
  No new dependencies.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- `hive new` (new projects from the CLI), UI changes, run retention/cleanup.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
