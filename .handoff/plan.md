## Goal

A **report download** for every finished run (done, failed or stopped; with or without commits): a
Markdown file with the run's facts, every prompt, the agent's final report, the error if any, and
the commit list. Built on the host from the run's saved data (`meta.json`); nothing new crosses
out of the VM. Surfaces: a **Download report** button in the web UI and `hive export --report` in
the CLI.

## Files to touch

- `src/runs.ts`
- `src/web-runs.ts`
- `src/cli.ts`
- `ui/src/main.ts`
- `test/export.test.mjs`
- `test/web-runs.test.mjs`
- `README.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `src/runs.ts`, keep every prompt:
   - Add `prompts?: { text: string; at: number }[]` to `RunMeta` (full prompt text, not cut).
   - `startRun` sets `meta.prompts = [{ text: o.prompt, at: Date.now() }]` (the user's prompt,
     without the new-project prefix); `continueRun` appends `{ text: o.prompt, at: Date.now() }`.
     Written with the meta writes that already happen there. `meta.prompt` (first 200 characters)
     stays as it is.

3. `src/runs.ts`: `export function reportMarkdown(name: string, meta: RunMeta): string`, a pure
   function returning:

   ```
   # <title: first non-empty line of the first prompt, max 120 characters>

   | | |
   |---|---|
   | Run | <name> |
   | Repository | <meta.createdRepo ?? meta.repo, or "new project <newRepo.name>"> |
   | Status | <done | failed | stopped (for "aborted") | running> |
   | Model | <provider> · <model> · thinking <thinking> |
   | Started | <createdAt as ISO, UTC, no milliseconds> |
   | Finished | <finishedAt as ISO, or "—"> |
   | Duration | <"12 min 3 s" from createdAt to finishedAt, or "—"> |
   | Cost | $<usage.cost with 4 decimals> (<input> in / <output> out tokens) |
   | Commits | <commits> |
   | Branch | <pushed.branch> (only when pushed) |
   | Pull request | <prUrl> (only when set) |

   ## Prompt            (or "## Prompts" with "### 1 — <ISO time>" per prompt when more than one)

   <prompt text>

   ## Report

   <meta.summary, or "_The agent left no report._">

   ## Error             (only when meta.error is set)

   ```text
   <meta.error>
   ```

   ## Commits           (only when meta.changes has commits)

   - <subject>
   ...
   ## Files changed     (only when meta.changes has files)

   - `path` (+added −removed, or "binary")
   ```

   For old runs without `meta.prompts`, use `meta.prompt` as the single prompt. Table cell values
   replace `|` with `\|` and newlines with spaces. Fenced blocks use a fence longer than any run of
   backticks inside the content.

4. `src/runs.ts`: `export function exportReport(dir: string, outPath: string): { path: string }`:
   refuse with `"run is still going"` when `isLive(meta)`; otherwise write
   `reportMarkdown(basename(dir), meta)` to `outPath`.

5. `src/cli.ts`: `hive export` gains `--report` (exactly one of `--zip`, `--bundle`, `--report`;
   default still `--zip`). Default output `<cwd>/<run name>.md`; refuses to overwrite without
   `--force`, like the other formats. Update the usage text.

6. `src/web-runs.ts`: `GET /export/:sessionId?format=report` → 200 with `reportMarkdown(id, meta)`,
   `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition: attachment;
   filename="<id>.md"`; 409 when the run is live (as for the other formats). The format check
   accepts `zip`, `bundle` and `report`; its error becomes `format must be zip, bundle or report`.

7. `ui/src/main.ts`:
   - Mark the banners made by `finishRun` (done, stopped, failed) with a new `final: true` field on
     the banner item, so other banners (like "Couldn't send") are unaffected.
   - Render `exportElement(item)` for every banner with `final: true`. Inside it, show **Download
     zip** only when the run has commits (the current condition), and always show a **Download
     report** button (`id="downloadReportBtn"`) that downloads `format=report` the same way as the
     zip (Blob + temporary `<a download>`; filename from `Content-Disposition`, else `<run id>.md`;
     `Preparing…` while waiting; errors shown like the zip's). The hint line reads `Built from the
     run's commits on this computer.` when the zip button shows, and `The prompt, the agent's
     report and the run's details, as Markdown.` when only the report button shows. Keep the git
     bundle button hidden as it is now.

8. Tests:
   - `test/export.test.mjs`: `reportMarkdown` for (a) a done run with two prompts, a summary,
     changes with one commit and one file, a pushed branch and a PR url: contains the title,
     `## Prompts`, both prompts, `## Report`, `## Commits`, the commit subject, the file line, the
     branch and the PR url, and no `## Error`; (b) an aborted run with an error containing a
     triple-backtick run and a `|` in the model name: shows `stopped`, `## Error` with a longer
     fence than the error's backticks, the escaped `\|` in the table, no `## Commits`; (c) an old
     run without `prompts`: uses `meta.prompt`. `exportReport` on a live run rejects with
     `run is still going` and on a finished one writes the file.
   - `test/web-runs.test.mjs`: `GET /export/<id>?format=report` on the file's fake run returns
     200, `text/markdown`, an attachment filename ending `.md`, and a body containing the run's
     prompt; `format=tar` → 400 with the new message.

9. `README.md`: `hive export --report` and the web UI's Download report button.

## Acceptance

- `npm run build` exits 0.
- `npm run build:ui` exits 0.
- `npm test` exits 0.
- `node --test test/export.test.mjs test/web-runs.test.mjs` exits 0 (after `npm run build`).
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
  the server or call GitHub/OpenRouter. If something outside Acceptance fails, note it in the
  report and finish.
- The report is built only from `meta.json`. Don't read files from `work/` or `io/` for it. Never
  run host git in `work/`. No new dependencies. Don't change `vm/`, `image/`, `src/sandbox.ts`.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Including the full event timeline (tool calls) in the report; reports for runs still going.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
