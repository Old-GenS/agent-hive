# One run engine (consolidation plan)

## Status

Stages 1 and 2 are done: the server engine (`src/tasks.ts`) is gone, and the web UI uses the CLI
run engine (`src/runs.ts`) through `src/web-runs.ts`. Runs are folders under `HIVE_RUNS_DIR`, so the
CLI and the server share them and runs survive restarts.

Built: the stall watchdog, export on failure, startup cleanup, the queue, follow-ups, review
cycles, new projects, run retention (`HIVE_RUN_RETENTION_DAYS`, 14 days), and OpenRouter provider
routing (`HIVE_OPENROUTER_ROUTING`).

Not built: stage 3, splitting `ui/src/main.ts` into modules.

## Why

agent-hive has two engines that each "do a run":

| | CLI (`src/runs.ts`) | Server (`src/tasks.ts`) |
|---|---|---|
| Where runs live | Folders on disk with `meta.json` | Memory only; task folders in `/tmp/hive-workspace`, wiped at start |
| Agent events | VM writes `io/events.jsonl`, host follows it | Same (since the fix) |
| Features only here | apply to your checkout, `hive diff`, push on demand | new projects, review cycles, follow-ups, change summary, PRs, issues, queue |

Every feature lands in one engine or the other, bugs get fixed twice, and the server forgets
everything on restart. The goal: **one engine (the core), runs stored as folders on disk, and the
CLI and the server as thin layers on top of it.**

## The core

`src/core/` owns everything about a run. Neither the CLI nor the server talks to the sandbox, git
or `gh` directly.

- **Run store:** one folder per run under `HIVE_RUNS_DIR` (default `~/.cache/agent-hive/runs`),
  shared by the CLI and the server, so `hive list` shows runs started from the web UI and the run
  list shows runs started with `hive run`. The run's id is its folder name
  (`<repo>-<YYYYMMDD-HHMMSS>`).

  ```
  <run>/
    meta.json         everything about the run (below), rewritten atomically
    events.jsonl      hive's own events for the whole run, appended (persisted for replay)
    work/             the agent's copy (/work)
    io/               prompt-<n>.md, system.md, agent-<n>.jsonl, stderr-<n>.log (/io)
    session/          pi's session (/session), so follow-ups continue it
    out/              exported patches
    origin/           clean clone used for pushing
  ```

- **meta.json (one schema for both):** id, title, source (`local` | `remote` | `new`), repo,
  branch, base, provider, model, thinking, review (cycles, model), status, prompts (each follow-up
  with its time), commits, changes (commits and files), usage, summary, pushed (branch, url),
  prUrl, issueUrl, createdRepo, error, pid, createdAt, finishedAt.

- **Statuses:** `queued` → `preparing` → `running` → `reviewing` → `exporting` → `pushing` →
  `done` | `failed` | `aborted`. A run whose `pid` is gone while its status is still active is
  marked `failed` with "interrupted (hive stopped)" the next time the store is read.

- **Steps:** prepare (clone your checkout, clone a URL, or a new empty repo) → agent step (one
  prompt; every backend writes to `io/` files, no stdout parsing) → review cycles → export patches
  → publish. Follow-ups add another agent step on the same `work/` and `session/`.

- **Publish policy, chosen by the caller:** the server pushes to a `hive/<run>` branch right away
  (today's behaviour); the CLI leaves it to `hive push`. Opening a PR, posting an issue and creating
  a new repo are core functions both can call.

- **Queue:** the core runs at most `MAX_CONCURRENT_SESSIONS` agent steps at once; the rest wait.

- **Watchdogs:** a VM never outlives its owner or its time limit, and a stuck run doesn't burn
  tokens:
  - the launcher (`vm/hive-vm`) gets the owner's process id and the time limit; it stops the VM if
    the owner disappears or time runs out, even when the CLI or server crashed (done before stage 1);
  - **stall watchdog:** the core stops a run when no file in `work/` changed and no event arrived for
    `HIVE_STALL_MIN` minutes (default 15; 0 turns it off), and records "stalled: nothing changed for
    N minutes";
  - **startup cleanup:** when the core starts, any `hive-vm` process belonging to a run whose
    recorded owner is gone is stopped, and that run is marked `failed` ("interrupted").

- **Events:** the core turns agent events into hive's own small set and appends them to the run's
  `events.jsonl`: `status`, `message` (text, streaming deltas while live), `tool` (name, detail),
  `tool_failed`, `usage`, `done` (result, changes, links, error). The UI, the CLI's renderer and any
  future agent adapter (dsh) only deal with these. Live subscribers get them as they happen; a late
  or reconnecting subscriber replays the file first.

## The layers on top

- **CLI:** `hive run`, `list`, `log`, `diff`, `apply`, `push`, `clean` call the core. It gains what
  only the server had: new projects, review cycles, follow-ups (`hive continue`), issues.
- **Server:** HTTP routes and the WebSocket map one-to-one onto core calls. `tasks.ts` goes away.
  Runs survive restarts; the run list reads the store. `hive serve` is the server.
- **Web UI:** unchanged screens; it uses run ids and hive events instead of session ids and pi
  events, and `ui/src/main.ts` is split into modules.

## Stages (each its own handoff, each leaves everything working)

1. **Core engine, CLI on top.** Build `src/core/` from `runs.ts` plus the server-only features, with
   the shared store, the meta schema, the queue and hive events. Move the CLI onto it. The server is
   untouched in this stage.
2. **Server on the core.** Routes, WebSocket and run list over the core; delete `tasks.ts`; runs
   survive restarts; the UI moves to run ids and hive events.
3. **Split the UI** into modules (pure refactor; the browser check must pass unchanged).

## Decisions

- **One shared run store** for the CLI and the server.
- **Finished runs are kept 14 days** (`HIVE_RUN_RETENTION_DAYS`), then cleaned up automatically; any
  run can be deleted earlier from the UI or with `hive clean`.
- **libkrun only.** Before stage 1, a cleanup removes what nothing uses any more: the podman
  backends (krun, gVisor, plain container), `/snippet`, `/files`, `/file`, `/messages`,
  `/api/github/search`, `/api/github/fork` and the old landing page. Machines without KVM wait for
  the planned gVisor step; the separate hive-mcp package (which used `/snippet`) is replaced later
  by a built-in `hive mcp` on the core.
