## Goal

Three fixes from real runs:

1. **Skip review cycles when the main step made no commits.** A "review and report" task makes no
   commits; its review cycle then rebuilds the project for nothing (a real run spent 20+ minutes
   there). Find out with the export step (in a VM, as today), never with host git in `work/`.
2. **Live cost.** A running run shows `$0.0000` in the run list and the CLI's `hive list` until it
   ends, because `meta.usage` is only written at the end. Save it while the run goes, and show a
   live cost on the web UI's run page.
3. **Markdown in the web UI's timeline.** The agent's messages show raw markdown (`## Heading`,
   `- item`, tables). Render a safe subset as HTML.

## Files to touch

- `src/runs.ts`
- `ui/src/markdown.ts` (new)
- `ui/src/main.ts`
- `ui/src/app.css`
- `test/run-steps.test.mjs`
- `test/markdown.test.mjs` (new)
- `README.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. **Skip pointless reviews** (`src/runs.ts`):
   - Move the export code in `runStepsInner` (empty `out/`, run the `hive-export` VM with
     `meta.base`, count `patchFiles(dir)`) into `async function exportPatches(dir: string, meta:
     RunMeta): Promise<{ ok: boolean; code: number; commits: number }>`, and use it for the final
     export exactly as today (same error handling).
   - Before the review loop, when the main step's status is `done`, `meta.reviewCycles > 0` and
     `work/` exists, call `exportPatches`. If it succeeds with `commits === 0`, skip the review
     cycles and call `o.onEvent({ type: "hive_note", text: "No commits, so the review was skipped." })`.
     If it fails, run the reviews as today (don't block on it).
   - Export a pure `export function shouldReview(o: { status: RunStatus; cycles: number; commits:
     number | undefined }): boolean` = `status === "done" && cycles > 0 && commits !== 0` and use
     it for that decision.

3. **Live cost** (`src/runs.ts`): in `agentStep`'s `followJsonl` callback, after `addUsage`, write
   `meta.json` (with `writeMeta`) at most once every 5 seconds while usage changed since the last
   write (track `lastUsageWrite` and the cost written). Keep the final write at the end as today.
   Export `export function usageWriteDue(now: number, last: number, changed: boolean): boolean` =
   `changed && now - last >= 5000` and use it.

4. **Markdown** (`ui/src/markdown.ts`, new, no dependencies, plain TypeScript with only erasable
   syntax: no `enum`, `namespace` or parameter properties, so Node can import it with type
   stripping): `export function renderMarkdown(text: string): string` returning HTML. **Escape
   everything first** with the same rules as `esc()` in `ui/src/util.ts` (copy that one-line
   function into the module so it stays self-contained), then build markup only from the escaped
   text. Supported:
   - fenced code blocks (```` ``` ```` with an optional language) → `<pre><code>…</code></pre>`,
     no further processing inside;
   - headings `#` to `####` → `<h3>` to `<h6>` (one level down, so a message never outranks the
     page title);
   - unordered lists (`- `, `* `) and ordered lists (`1. `), one level, consecutive lines;
   - GitHub-style tables (a header row, a `|---|` separator row, body rows) → `<table>` with
     `<thead>`/`<tbody>`;
   - blank-line-separated paragraphs → `<p>`, single newlines inside a paragraph → `<br>`;
   - inline: `` `code` ``, `**bold**`, `*italic*` / `_italic_`, and links `[text](url)` only when
     the url starts with `https://` or `http://` → `<a href="…" target="_blank" rel="noopener
     noreferrer">`; any other url leaves the text as plain text.
   - Nothing else produces tags; raw HTML in the input stays escaped text.
   In `ui/src/main.ts`, `formatContent` returns `renderMarkdown(text)` (keep the function name; it
   is used for assistant items). Add styles in `ui/src/app.css` for headings, lists, tables
   (borders from the existing tokens, horizontal scroll on narrow screens), `pre` and `code` inside
   timeline assistant items, matching the existing light and dark tokens.

5. **Live cost on the run page** (`ui/src/main.ts`): keep a running total of
   `event.message.usage.cost.total` from assistant `message_end` events in the run state and show
   it in the run page's meta line (`<repo> · <provider> · <model> · $0.0123`, four decimals),
   updated as events arrive; on `hive_done` use `event.usage.cost` when present.

6. Tests:
   - `test/markdown.test.mjs` (new): import `../ui/src/markdown.ts` directly (Node strips the
     types). Cases: a heading, a list, an ordered list, a table, a fenced code block whose content
     contains `**not bold**` and `<b>` (stays literal and escaped), inline code/bold/italic, an
     `https` link (gets `rel="noopener noreferrer"`), a `javascript:alert(1)` link (no `<a`, no
     `javascript:` inside an attribute), raw `<script>alert(1)</script>` (escaped, no `<script`),
     and an attribute-breaking attempt like `[x](https://a.com/"onmouseover="alert(1))` (no
     unescaped `"` inside the href).
   - `test/run-steps.test.mjs`: `shouldReview` (done + cycles + 0 commits → false; done + cycles +
     undefined → true; failed → false; 0 cycles → false) and `usageWriteDue`.

7. `README.md`: one line each in the relevant sections: reviews are skipped when the run made no
   commits; the cost updates while a run goes; the web UI renders the agent's markdown.

## Acceptance

- `npm run build` exits 0.
- `npm run build:ui` exits 0.
- `npm test` exits 0.
- `node --test test/markdown.test.mjs test/run-steps.test.mjs` exits 0 (after `npm run build`).
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
- Never run host git in `<run>/work`. Don't change `vm/`, `image/`, `src/sandbox.ts` or
  `src/stall.ts`. No new dependencies (no markdown library).
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Markdown anywhere but the timeline's assistant messages; nested lists; images.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
