## Goal

Make dropped model connections cost less: the agent takes fewer screenshots, a run retries once
by itself after a dropped connection, the error says what happened, and continuing a failed run is
one click in the web UI and one short command in the CLI.

## Files to touch

- `src/config.ts`, `src/runs.ts`, `src/cli.ts`, `src/web-runs.ts` (only if needed for the UI)
- `ui/src/main.ts`, `ui/src/app.css`
- `test/run-steps.test.mjs`, `test/run-status.test.mjs`, `test/cli.test.mjs`
- `docs/CLI.md`, `docs/HOW-IT-WORKS.md`, `README.md` (only if it describes continuing)
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`, then `cd ui && npm ci && cd ..`.

2. Agent instructions (`src/config.ts`, the default system prompt string around line 115): append
   one sentence: "Check web pages through the DOM, console output or tests where you can; take
   screenshots only when the look itself matters, and don't re-open old ones: every image stays in
   the conversation and slows each later request."

3. Transient-error detection (`src/runs.ts`): add and export
   `export function isTransientModelError(error: string | undefined): boolean` — true when the text
   matches `/UND_ERR_SOCKET|other side closed|ECONNRESET|socket hang up|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|terminated|Connection error/i`
   AND does not match `/40[0-4]|unauthori[sz]ed|invalid.{0,20}key|quota|insufficient|context length|too long/i`.

4. One automatic retry (`src/runs.ts`, `runStepsInner`): after the main `agentStep`, if
   `main.status === "failed"`, `isTransientModelError(main.error)` is true, the run was not aborted
   (`o.signal.aborted` false) and this is the first retry of this step:
   - emit `o.onEvent({ type: "hive_note", text: "The model connection dropped; trying again in 60 s
     in the same session." })`;
   - wait 60 s, abortable through `o.signal` (an abort during the wait ends the step as aborted,
     the same way an abort during a step does);
   - run `agentStep` again with `session: "continue"`, the same model, prompt
     `"The last model request failed because the connection dropped. Continue the task from where
     you left off; don't redo finished work."`;
   - its result replaces `main` (status, error, summary).
   Only once per `runStepsInner` call; review steps never retry. The 60 s is a named constant
   `TRANSIENT_RETRY_DELAY_MS`; tests may override it through an option on `RunStepsOptions`
   (`retryDelayMs`), not an env var.

5. Clearer error (`src/runs.ts`, `finalStatus`): when the model error is transient
   (`isTransientModelError`), the error text becomes
   `model error: <original> — the provider closed the connection before answering (a busy API, or a
   long wait for the first token; many images in the conversation make that more likely). Continue
   the run to pick up where it stopped.` Non-transient errors are unchanged.

6. CLI continue (`src/cli.ts`, the continue command around line 523):
   - two positionals: `<run> <prompt>` as now;
   - one positional: if `resolveRun()` finds a run with exactly that id/name, continue that run with
     the default prompt; otherwise treat it as the prompt for the newest run (as now);
   - none: the newest run with the default prompt.
   - default prompt: `"Continue the task from where you left off; don't redo finished work."`
   - Usage line: `hive continue [run] ["<prompt>"]`. Make sure runs started from the web UI
     (`hive serve`) are found by `resolveRun` and listed by `hive list` (they share the runs folder;
     if they don't, note it in the report and don't change it).

7. Web UI (`ui/src/main.ts`): on a run whose status is failed, stopped/aborted, timed out or
   stalled (the non-busy, non-done states), show a primary "Continue" button in the run header
   next to the status pill, which sends the default prompt from step 6 through the same path the
   follow-up box uses (`sendFollowUp` / POST `/prompt` with `sessionId`). Hide it while the run is
   busy and on done runs. Below the error text add one muted line: "Continue picks up where it
   stopped, in the same session." Make the follow-up box's placeholder
   "Send a follow-up, or Continue to pick up where it stopped" on those states. Keep the existing
   styles; add CSS only if needed.

8. Tests:
   - `test/run-status.test.mjs`: `isTransientModelError` (UND_ERR_SOCKET and "other side closed"
     true; a 401 text false; "context length exceeded" false; undefined false); `finalStatus` with a
     transient model error includes "closed the connection" and with a 401 does not.
   - `test/run-steps.test.mjs`: using the existing fakes in that file, a main step failing with
     `other side closed (UND_ERR_SOCKET)` then succeeding → run done, two agent steps, the second
     with `session: "continue"`, a `hive_note` emitted (`retryDelayMs: 0`); a second transient
     failure → failed, no third step; a 401 failure → no retry; an abort → no retry.
   - `test/cli.test.mjs`: the continue argument parsing (extract it into a small exported pure
     function in `src/cli.ts` if that's the easiest way to test it).

9. Docs: `docs/CLI.md` continue row (run optional, prompt optional, default prompt, works for web
   UI runs); `docs/HOW-IT-WORKS.md`: one short paragraph on the single automatic retry after a
   dropped model connection and the Continue button.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/run-status.test.mjs test/run-steps.test.mjs test/cli.test.mjs` exits 0 (after `npm run build`).
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
  VM); never boot a hive VM, start `hive run`, start the server or call GitHub/OpenRouter/DeepSeek.
  If something outside Acceptance fails, note it in the report and finish.
- No new npm dependencies. Don't change `vm/`, `image/`, `.github/` or `scripts/`.
- Never mention pi-vm or dsh in docs or code.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- The Settings editor, retries for review steps, changing pi's own retry settings, image pruning
  inside pi.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
