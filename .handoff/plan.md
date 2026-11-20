## Goal

The web UI (`ui/`, served by `hive serve` from `src/index.ts`) starts and follows runs with the CLI
run engine (`src/runs.ts`), the same engine as `hive run`. The old server engine was deleted
(`src/tasks.ts`, `src/routes/sessions.ts`, removed in commit `9cce3c2`; read them with
`git show 9cce3c2^:src/tasks.ts` and `git show 9cce3c2^:src/routes/sessions.ts`). Rebuild the
routes the UI calls, with the **same URLs, request bodies and response/event shapes** as the
deleted `src/routes/sessions.ts`, but backed by `src/runs.ts`. The UI should need no changes.

## Files to touch

- `src/runs.ts`
- `src/web-runs.ts` (new)
- `src/index.ts`
- `test/web-runs.test.mjs` (new)
- `README.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `src/runs.ts`: add an optional `onStart?: (dir: string, meta: RunMeta) => void` to
   `StartRunOptions`, called in `startRun` right after the first `writeMeta(dir, meta)` (the one
   that writes `status: "running"`). Change nothing else in this file.

3. `src/web-runs.ts` (new), a Fastify plugin `export default async function webRunRoutes(app)`
   plus the helpers below. A run's **id** is its folder name under `config.runsDir`
   (`basename(dir)`). `runDir(id)`: reject ids not matching `/^[A-Za-z0-9._-]+$/` or without a
   `meta.json` in `join(config.runsDir, id)` (→ 404 `{ error: "Session not found" }`).
   - **Live registry:** `Map<id, { abort: AbortController; replay: any[]; listeners: Set<(e) => void> }>`
     for runs started by this process. `publish(id, event)` pushes to `replay` and calls each listener.
   - `export function uiStatus(meta: RunMeta, live: boolean)`: `"running"` while live, else
     `done` → `"idle"`, `failed` → `"failed"`, `aborted` → `"aborted"`, `running` (not live) →
     `"failed"`.
   - `export function runToJSON(id, meta, live, changes?)` returns the same field names as the old
     `Task.toJSON()` (see `git show 9cce3c2^:src/tasks.ts`): `sessionId` = id, `title` = first line
     of `meta.prompt` (max 80 chars), `status` = `uiStatus`, `isStreaming` = live, `repo` =
     `meta.repo`, `resultBranch` = `meta.pushed?.branch`, `commitsPushed` = `meta.pushed ?
     meta.commits : 0`, `changes`, `prUrl`, `issueUrl` (new optional `RunMeta`-compatible field you
     store in meta.json; add `issueUrl?: string` to `RunMeta` in step 2 if needed), `repoSlug` =
     `githubSlug(meta.pushed?.url ?? meta.repo)`, `usage`, `provider`, `model`, `thinkingLevel` =
     `meta.thinking`, `error`, `isolation: runtimeInfo.isolation`, `createdAt`,
     `stepStartedAt` = `meta.createdAt`, `finishedAt`.
   - `POST /prompt` (same JSON schema as the old route):
     - `sessionId` set → 400 `{ error: "Follow-ups aren't supported yet" }`.
     - `newRepo` set → 400 `{ error: "New projects aren't supported yet" }`.
     - `reviewCycles > 0` → 400 `{ error: "Review cycles aren't supported yet" }`.
     - `repo` missing → 400 `{ error: "Pick a repository" }`.
     - live runs ≥ `config.maxConcurrent` → 503 `{ error: "All worker bees are busy; try again when a run finishes" }`.
     - Otherwise: `const remote = { ...normalizeRepo(repo), ref: branch }`; create an
       AbortController; call `startRun({ remote, prompt, provider, model, thinking: thinkingLevel,
       signal, onEvent: (e) => publish(id, e), onStart })` without awaiting its end. Respond only
       once `onStart` fires (register the live entry there and `publish(id, { type: "hive_status",
       status: "running" })`), with `{ sessionId: id, status: "running", repo, model, provider,
       stepStartedAt, finishedAt: undefined }`. If `startRun` throws before `onStart`, respond 400
       `{ error: message }`.
     - When `startRun` resolves: if `meta.status === "done" && meta.commits > 0`, publish
       `{ type: "hive_status", status: "pushing" }` and call `pushRun(dir)`; on failure set
       `meta.error` to the message and `writeMeta`. Compute `changes` with
       `changeSummary(join(dir, "work"), meta.base)` when `meta.commits > 0` (ignore errors) and
       keep it in an in-memory `Map<id, ChangeSummary>`. Then publish
       `{ type: "hive_done", ...runToJSON(id, readMeta(dir), false, changes) }` (its `status` is
       `"failed"` when a push failed: set it explicitly) and delete the live entry. If `startRun`
       rejects after `onStart`, publish a `hive_done` with `status: "failed"` and the error.
   - `GET /runs` → `{ runs: listRuns().map(...runToJSON) (newest first), capacity: { running:
     <live count>, queued: 0, max: config.maxConcurrent } }`.
   - `GET /status/:sessionId` → `runToJSON` (404 as above).
   - `POST /abort/:sessionId` → abort the live run's controller; 409
     `{ error: "Run isn't running" }` when not live; else `{ sessionId, status: "aborted" }`.
   - `DELETE /session/:sessionId` → 409 when live, else `cleanRun(dir)` and
     `{ sessionId, status: "destroyed" }`.
   - `POST /pr/:sessionId` → `openPr(dir)`; return `{ sessionId, url }`; errors → 400.
   - `POST /issue/:sessionId` → needs a GitHub slug from `meta.repo` (400 otherwise); `openIssue({
     slug, title: "Review: " + title, body: issueBody(meta.summary ?? "", { model: meta.model,
     baseSha: meta.base }) })`; store `issueUrl` in meta.json; return `{ sessionId, url }`;
     errors → 400.
   - `POST /events/:sessionId/ticket` → `{ ticket: issueTicket(req.hiveUser!, id) }`.
   - `GET /events/:sessionId` (websocket; the ticket is checked by the existing auth hook exactly
     as before): for a live run send its `replay` then each new event; for a finished run send
     every line of `join(dir, "io", "events.jsonl")` parsed as JSON (skip bad lines), then one
     `{ type: "hive_done", ...runToJSON(...) }`. Remove the listener on close.

4. `src/index.ts`: `import webRunRoutes from "./web-runs.js"` and register it in the authenticated
   scope where `sessionRoutes` used to be, plus `api.get("/capacity", ...)` returning the same
   capacity object as `GET /runs`. Export a `liveCount()` from `src/web-runs.ts` for that.

5. `test/web-runs.test.mjs` (new): set `process.env.HIVE_RUNS_DIR` to a temp dir (from
   `os.tmpdir()`) **before** importing anything from `../dist/`. Write one fake run folder
   `<tmp>/demo-20260101-000000/meta.json` (status `done`, commits 0, a prompt, provider, model,
   thinking, usage from `emptyUsage()` in `../dist/render.js`, createdAt, finishedAt) and an
   `io/events.jsonl` with two event lines. Build a bare Fastify app (`fastify()` and
   `@fastify/websocket`, no auth hook), register the plugin, and with `app.inject` check:
   - `GET /runs` lists `demo-20260101-000000` with `status: "idle"`;
   - `GET /status/demo-20260101-000000` returns `sessionId`, `title`, `status: "idle"`;
   - `GET /status/nope` and `GET /status/..%2Fx` → 404;
   - `POST /prompt` with `{ prompt: "x", sessionId: "demo-20260101-000000" }` → 400 mentioning
     follow-ups; with `newRepo` → 400; with `reviewCycles: 1` → 400; with no `repo` → 400;
   - `POST /abort/demo-20260101-000000` → 409;
   - `uiStatus` and `runToJSON` cases for each status mapping.
   Close the app at the end.

6. `README.md`: in the web UI section, say the web UI uses the same run engine and run folders as
   `hive run`, so `hive list` shows web runs and the web run list shows CLI runs; and that
   follow-ups, review cycles and new projects aren't available from the web UI yet.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/web-runs.test.mjs` exits 0 (after `npm run build`).
- `grep -rn "tasks.js" src` prints nothing.
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
- Don't change `ui/`, `vm/`, `image/`, `src/sandbox.ts`, `src/stall.ts` or the run logic in
  `src/runs.ts` beyond step 2. No new dependencies.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Follow-ups, review cycles, new projects and a run queue in the CLI engine.
- Any UI change.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
