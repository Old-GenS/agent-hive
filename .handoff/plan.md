## Goal

Finish the run engine's remaining protections and features, all in the CLI engine (`src/runs.ts`)
with thin hooks in the web layer (`src/web-runs.ts`, `src/index.ts`) and the CLI (`src/cli.ts`):

1. **Startup cleanup:** a VM left behind by a crashed hive is stopped, and its run is marked failed.
2. **Time limit note:** the agent is told its deadline, so it commits in time.
3. **Slim saved logs:** streaming-only events are dropped from a step's saved event log once the
   step ends (live streaming is unchanged).
4. **Run retention:** finished runs older than 14 days are deleted automatically.
5. **`hive new`:** start a new project from the terminal.
6. **OpenRouter routing and models.json,** ported from pi-vm (`~/code/pi-vm/bin/pi-vm` is not in
   this repo; the logic to port is described in step 7).

## Files to touch

- `src/runs.ts`
- `src/openrouter.ts` (new)
- `src/config.ts`
- `src/web-runs.ts`
- `src/index.ts`
- `src/cli.ts`
- `ui/src/main.ts`
- `test/cleanup.test.mjs` (new)
- `test/openrouter.test.mjs` (new)
- `test/run-steps.test.mjs`
- `README.md`
- `.env.example`
- `docs/CORE.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. **Startup cleanup** (`src/runs.ts`): `export function recoverRuns(o: { procRoot?: string;
   kill?: (pid: number) => void } = {}): string[]` (returns the names of runs it recovered). For
   every run in `listRuns()` whose `meta.status` is `"running"` or `"queued"` and whose `meta.pid`
   is gone (`!isLive(meta)`):
   - find processes whose `/proc/<pid>/cmdline` (NUL-separated; `procRoot` defaults to `/proc`)
     contains an argument ending in `hive-vm` **and** an argument that contains `<run dir>/`;
     send each `SIGTERM` (`o.kill ?? ((pid) => process.kill(pid, "SIGTERM"))`, ignore errors);
   - set `status: "failed"`, `error: "interrupted (hive stopped)"`, `finishedAt: Date.now()` and
     write meta.
   Unreadable `/proc` entries are skipped. Call `recoverRuns()` once at server start in
   `src/index.ts` (before `listen`, log how many were recovered) and at the start of `hive run`,
   `hive continue`, `hive new` and `hive list` in `src/cli.ts`.

3. **Time limit note** (`src/runs.ts`): `startRun` writes the run's system prompt
   (`o.systemPrompt || config.systemPrompt`) to `io/system-base.md` instead of `io/system.md`.
   Before each agent step, `agentStep` writes `io/system.md` = the contents of
   `io/system-base.md` (or `config.systemPrompt` when that file is missing, for older runs) +
   `"\n\n" + timeNote(config.sandbox.timeoutMin, new Date())`, where
   `export function timeNote(minutes: number, start: Date): string` returns:
   `This run has a time limit of <minutes> minutes and is stopped at <ISO time of start + minutes,
   UTC, no milliseconds> (UTC; check with \`date -u\`). Commit as you go. When 10 minutes are left,
   start no new work: commit what you have and finish.`

4. **Slim saved logs** (`src/runs.ts`): after each agent step's VM has exited (after the stall
   watch is stopped and before `finalStatus`), rewrite `io/events.jsonl` keeping every line except
   those whose parsed `type` is `"message_update"` or `"tool_execution_update"` (keep lines that
   don't parse). Write to `io/events.jsonl.tmp` and `renameSync`. Export a pure
   `export function slimEvents(text: string): string` for this and use it.
   `ui/src/main.ts`, in `handleEvent` `case "message_end"`: before the existing empty-text check,
   if `run.currentAssistant` has no text, set it from the event's message content (join the
   `text` of content blocks with `type === "text"`) and call `updateItem`, so a replayed run (no
   `message_update` events) still shows the agent's messages. Change nothing else in the UI.

5. **Run retention** (`src/runs.ts`, `src/config.ts`): `config.runRetentionDays =
   int("HIVE_RUN_RETENTION_DAYS", 14)` (0 = keep forever). `export function pruneRuns(now =
   Date.now()): string[]` deletes (with `cleanRun`) every run that is not live, has a
   `finishedAt`, and `now - finishedAt > days * 86_400_000`; returns the deleted names; does
   nothing when days is 0. Call it at server start (after `recoverRuns`) and then every 6 hours
   (`setInterval(...).unref()`) in `src/index.ts`, and at the start of `hive run` and `hive new`.

6. **`hive new`** (`src/cli.ts`): `hive new <name> [--public] [-m model] [-p provider]
   [-t thinking] [--review <n>] [--review-model <model>] "<prompt>"` (or `-f <prompt-file>`),
   calling `startRun({ newRepo: { name, private: !public }, ... })` and rendering events like
   `hive run`. On success print the run name and `hive push <name>` (which creates the GitHub repo
   through the existing `pushRun` new-project path). Add it to the CLI usage text.

7. **OpenRouter routing and models.json** (`src/openrouter.ts`, new; `src/runs.ts`;
   `src/config.ts`):
   - `config.openrouterRouting`: parsed JSON from `HIVE_OPENROUTER_ROUTING`, default
     `{"quantizations":["fp16","bf16","fp8"]}`; invalid JSON or a non-object → throw a clear error
     when used.
   - `export function modelsJson(m: any, routing: object)`: pi's models.json for one model from
     OpenRouter's `/api/v1/models` entry `m`: `{ providers: { openrouter: { models: [{ id: m.id,
     name: m.name, reasoning: (m.supported_parameters ?? []).includes("reasoning"), input:
     (m.architecture?.input_modalities ?? []).includes("image") ? ["text","image"] : ["text"],
     contextWindow: m.context_length, maxTokens: m.top_provider?.max_completion_tokens ?? 32000,
     cost: { input, output, cacheRead, cacheWrite } (each = Number(price ?? "0") * 1_000_000 from
     m.pricing.prompt, .completion, .input_cache_read, .input_cache_write), compat: routing is {} ?
     {} : { openRouterRouting: routing } }] } } }`.
   - `export function rankEndpoints(endpoints: any[], routing: any, model: string): { routing:
     any; note?: string }`: if `routing` has `order` or `only`, return it unchanged. Let `up` =
     endpoints with `(status ?? 0) === 0`. If `routing.quantizations` is set, `up` is non-empty and
     no endpoint in `up` has an allowed quantization, drop `quantizations` from the routing and set
     `note` to `no endpoint of <model> is <q joined by "/">; allowing any for this run`. Then keep
     endpoints that are up, have an allowed quantization (if any filter remains), list `"tools"`
     in `supported_parameters`, and have a non-null `pricing.input_cache_read`. Sort: the model
     maker's own endpoint first (`tag.split("/")[0]` equals `model.split("/")[0]`,
     case-insensitive), then higher `Math.floor(uptime_last_1d ?? 0)` first, then lower
     `Number(pricing.prompt)`. If none remain return the routing as is; otherwise return
     `{ ...routing, order: tags, allow_fallbacks: true }`.
   - `export async function openrouterSetup(model: string, routing: any, fetchImpl = fetch)`:
     GET `https://openrouter.ai/api/v1/models` (20 s timeout via `AbortSignal.timeout`), find the
     model by `id` (not found → throw `model '<id>' not found on OpenRouter (see
     https://openrouter.ai/models)`); GET `https://openrouter.ai/api/v1/models/<model>/endpoints`
     (on failure keep `routing` as is and set a note `couldn't list providers for <model>; letting
     OpenRouter choose`), rank with `rankEndpoints(data.endpoints, ...)`; return `{ modelsJson,
     routing, note? }`.
   - `src/runs.ts`: when the run's provider is `openrouter`, `startRun` calls `openrouterSetup`
     **before** `makeRunDir` (errors reject `startRun` with nothing created), then writes
     `<run>/agent/models.json` (`JSON.stringify(..., null, 2)`) and `<run>/agent/settings.json`
     (`{ "enableInstallTelemetry": false }`), stores `meta.routing` (the final routing object), and
     passes the note (if any) to `o.onEvent({ type: "hive_note", text: note })`. Every agent step
     of an openrouter run (including follow-ups and reviews) mounts `<run>/agent` read-only at
     `/pi-agent` (`ro: true`) and adds `PI_CODING_AGENT_DIR=/pi-agent` to the VM env. Add
     `routing?: unknown` to `RunMeta`. Runs of other providers are unchanged.
   - `src/cli.ts`: `hive run` and `hive new` print `providers, in order: <a, b, c>` when
     `meta.routing.order` is set (read meta after `onStart`, or print it from the run's meta in the
     final summary; either is fine).

8. Tests (each sets `HIVE_RUNS_DIR`, `HIVE_KEYS_FILE` and `HIVE_DOTENV_PATH` to temp paths before
   importing `../dist/`, like `test/web-runs.test.mjs`):
   - `test/cleanup.test.mjs` (new): `recoverRuns` with a fake `procRoot` dir holding
     `<pid>/cmdline` files (NUL-separated args; one for `.../vm/hive-vm --share <run dir>/work:/work`,
     one unrelated) and a run whose meta has `status: "running"` and a pid that doesn't exist
     (e.g. 2147483646): the fake `kill` is called with the matching pid only, and the run becomes
     `failed` / `interrupted (hive stopped)`. A `done` run is untouched. `pruneRuns`: a run finished
     15 days ago is deleted, one finished 1 day ago is kept, a running one is kept; with
     `HIVE_RUN_RETENTION_DAYS=0` nothing is deleted (test this with a dynamic import in a child
     process or by checking the function honours `config.runRetentionDays`; pick one that works).
   - `test/openrouter.test.mjs` (new): `modelsJson` on a fixture model (prices `"0.0000004"` →
     `0.4`, image input, reasoning, `{}` routing → `compat: {}`); `rankEndpoints` on fixture
     endpoints: maker first, then uptime, then price; endpoints that are down, lack tools, lack
     cache pricing or have a disallowed quantization are dropped; an all-fp4 list drops the
     quantization filter and sets the note; a routing with `order` is returned unchanged;
     `openrouterSetup` with a fake `fetchImpl` (unknown model → throws; endpoints call failing →
     routing unchanged with the note).
   - `test/run-steps.test.mjs`: add `timeNote(60, new Date("2026-01-01T10:00:00Z"))` contains
     `60 minutes` and `2026-01-01T11:00:00Z`; `slimEvents` drops `message_update` and
     `tool_execution_update` lines and keeps others and unparsable lines.

9. Docs: `README.md` — `hive new`, startup cleanup, the time note, retention
   (`HIVE_RUN_RETENTION_DAYS`), OpenRouter routing (`HIVE_OPENROUTER_ROUTING`), slim saved logs.
   `.env.example` — `HIVE_RUN_RETENTION_DAYS` and `HIVE_OPENROUTER_ROUTING` commented out with
   their defaults. `docs/CORE.md` — add a short "Status" section at the top: the server engine
   (`tasks.ts`) is gone, the web UI uses the CLI engine through `src/web-runs.ts`, and list what
   is built (stall watchdog, export on failure, startup cleanup, queue, follow-ups, reviews, new
   projects, retention, OpenRouter routing) and what isn't (splitting `ui/src/main.ts`).

## Acceptance

- `npm run build` exits 0.
- `npm run build:ui` exits 0.
- `npm test` exits 0.
- `node --test test/cleanup.test.mjs test/openrouter.test.mjs test/run-steps.test.mjs` exits 0
  (after `npm run build`).
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
  the server, call `gh`/GitHub, or make real requests to openrouter.ai (tests use fake fetch). If
  something outside Acceptance fails, note it in the report and finish.
- Don't change `vm/`, `image/`, `src/sandbox.ts` or `src/stall.ts`. Keep the stall watchdog,
  `finalStatus`, the shared caches, export-on-failure, follow-ups, reviews, new projects and the
  queue working as they are. No new dependencies.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Splitting `ui/src/main.ts`, packaging, a tray icon, a no-KVM fallback, a VM size editor.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
