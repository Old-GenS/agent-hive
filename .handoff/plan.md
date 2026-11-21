## Goal

A Settings › Runs page in the web UI where the user edits the run settings that today need
`~/.config/agent-hive/env`: VM CPUs, VM memory, runs at once, time limit, stall time and disk
limit per run. Saved to the keys file; applied to new runs without a server restart; values set in
the server's environment shown read-only; checked against this computer's CPUs and memory.

## Files to touch

- `src/settings.ts` (new), `src/routes/settings.ts` (new), `src/index.ts` (register the route)
- `src/config.ts`, `src/web-runs.ts`
- `ui/src/main.ts`, `ui/src/app.css`
- `test/settings.test.mjs` (new), `test/web-runs.test.mjs` (only if slots tests need updating)
- `docs/CONFIGURATION.md`, `docs/SERVER.md`, `AGENTS.md`, `README.md` (only if it says Settings is
  read-only)
- `.handoff/report.md`

## Steps

1. Run `npm ci`, `npm run build:vm`, `cd ui && npm ci && cd ..`.

2. `src/settings.ts` (new). One table of editable settings:

   | key (API) | env name | config field | type | default | min | max |
   |---|---|---|---|---|---|---|
   | `cpus` | `HIVE_SANDBOX_CPUS` | `config.sandbox.cpus` (string) | int | 1 | 1 | host CPU count |
   | `memoryMiB` | `HIVE_SANDBOX_MEMORY` | `config.sandbox.memory` (string like `2048m`) | int MiB | 2048 | 512 | host total MiB − 1024 |
   | `maxConcurrent` | `MAX_CONCURRENT_SESSIONS` | `config.maxConcurrent` | int | 2 | 1 | 16 |
   | `timeoutMin` | `HIVE_SANDBOX_TIMEOUT_MIN` | `config.sandbox.timeoutMin` | int | 60 | 5 | 1440 |
   | `stallMin` | `HIVE_STALL_MIN` | `config.sandbox.stallMin` | int | 15 | 0 (off) | 240 |
   | `diskMaxGb` | `HIVE_RUN_DISK_MAX_GB` | `config.sandbox.diskMaxGb` | int | 20 | 0 (off) | 1000 |

   Exports:
   - `readSettings()`: per key `{ value, default, min, max, source: "default" | "file" | "env" }`.
     `source` is `"env"` when the env name is set in `shellEnv` (from `src/config.ts`: the
     environment before the keys file was loaded), `"file"` when it is in `readKeysFile()`, else
     `"default"`. Memory is reported in MiB (use `parseMemoryMiB` from `src/sandbox.ts`).
   - `host()`: `{ cpus: os.availableParallelism(), memoryMiB: Math.floor(os.totalmem() / 2 ** 20) }`.
   - `validateSettings(patch, host)` → `{ ok: true, values, warnings: string[] } | { ok: false,
     errors: Record<key, string>, warnings: string[] }`. Each value an integer within its min/max
     (the message names the limit, e.g. "at most 8 (this computer's CPUs)"). Combined checks with
     the patched-or-current values: `memoryMiB * maxConcurrent > host.memoryMiB - 1024` is an
     error on `maxConcurrent` ("4 runs × 4096 MiB needs 16 GiB; this computer has 15.5 GiB");
     `cpus * maxConcurrent > host.cpus` is a warning only (VMs share CPUs fine).
   - `applySettings(values)`: for each key: throw if its source is `env`; write it with
     `setKeysFileValue(envName, String(v))` (memory as `<n>m`); set `process.env` and the `config`
     field so new runs use it right away; for `maxConcurrent` call `setMaxConcurrent(n)` (step 3).
   - `resetSetting(key)`: remove it from the keys file (`setKeysFileValue(name, null)`), restore
     the default in `config` and `process.env` (delete the var), throw for `env`.

3. `src/web-runs.ts`: the slots object gets `setMax(n)`: raising it starts queued waiters up to the
   new max; lowering it never stops running runs (new ones wait until running < max). Export
   `setMaxConcurrent(n)` that calls it and sets `config.maxConcurrent`. `capacity()` keeps reporting
   `config.maxConcurrent`. Test `setMax` up and down next to the existing `createSlots` tests.

4. `src/routes/settings.ts` (new), registered in `src/index.ts` inside the authenticated API scope
   like the other `/api/*` routes:
   - `GET /api/settings` → `{ settings: readSettings(), host: host() }`.
   - `PUT /api/settings`: body an object with any of the six keys (integers; JSON schema with
     `additionalProperties: false`). 400 `{ errors, warnings }` when validation fails; 409
     `{ error }` naming the env var when a key is set in the environment; else apply and return
     `{ settings, host, warnings }`.
   - `DELETE /api/settings/:key` → reset to default (404 unknown key, 409 env).

5. Web UI (`ui/src/main.ts`): a third Settings sub-page **Runs** (`#settings/runs`), next to
   "API keys" and "This computer", in the same layout and styles. A form, one row per setting:
   label, a short help line, a number input with its unit (CPUs / MiB with a GiB hint / runs /
   minutes / GB) and min/max from the API, a muted "default: N", and a "Reset" link when the source
   is `file`. A setting whose source is `env` shows its value disabled with "Set by <ENV_NAME> in
   the server's environment". Below the form, a live line that updates as the user types:
   "Up to N runs × M CPUs × G GiB = A CPUs and B GiB of this computer's X CPUs and Y GiB". Save
   button: `PUT`, field errors inline under each input, warnings in a muted note, success text
   "Saved. New runs use these settings." Labels and help:
   - CPUs per run — "Virtual CPUs each run's VM gets."
   - Memory per run — "RAM each run's VM gets. Browsers and builds need 2 GiB or more."
   - Runs at once — "More runs wait in a queue."
   - Time limit — "A run is stopped after this long; committed work is kept."
   - Stall time — "Stop a run when nothing changed for this long. 0 turns it off."
   - Disk per run — "Stop a run whose files grow past this. 0 turns it off."
   On "This computer", next to the VM size/limits it already shows from `/api/system`, add a link
   "Change in Settings › Runs".

6. Tests (`test/settings.test.mjs`; use a temp keys file through whatever env var `src/keys.ts`
   reads for its path, and the built `dist/` like the other tests): `validateSettings` limits, the
   memory × runs error and the CPU warning; `readSettings` sources (default / file / env — if
   `shellEnv` can't be controlled in-process, test through a child process with the env set);
   `applySettings` writes the file (mode stays 600) and updates `config`; it refuses env-set keys;
   `resetSetting`. Route tests in the style of the existing server route tests (find how
   `test/*.test.mjs` start the Fastify app with auth): GET shape, PUT 400 / 409 / 200, DELETE.

7. Docs: `docs/CONFIGURATION.md` — these six can also be changed in Settings › Runs, which writes
   the same file and applies to new runs without a restart (the CLI reads the file when it
   starts); `docs/SERVER.md` — one line under the web UI section; `AGENTS.md` — layout rows for
   `src/settings.ts` and `src/routes/settings.ts`, and the `ui/` row mentions Settings › Runs.
   README only if it calls Settings read-only.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/settings.test.mjs` exits 0 (after `npm run build`).
- `npm run build:ui` exits 0.
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
  VM); never boot a hive VM, start `hive run`, start the server outside tests or call
  GitHub/OpenRouter/DeepSeek. If something outside Acceptance fails, note it in the report and
  finish.
- No new npm dependencies. Don't change `vm/`, `image/`, `scripts/` or `.github/`.
- Every new API route stays inside the authenticated scope; render any server text in the UI with
  `esc()` or `textContent`.
- Never mention pi-vm or dsh in docs or code.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Provider/model defaults, network mode, cache settings, retention, editing from the CLI.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
