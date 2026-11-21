## Goal

Two pieces of work, done in order:

1. **The web UI in the release bundle.** `scripts/build-release.sh` packs the CLI into one file
   (`lib/hive.mjs`) with its own Node and the launcher, but not the web UI's files, so `hive serve`
   from an installed release has no pages. Ship `ui/dist` in the bundle and prove `hive serve`
   from a built bundle serves the UI.
2. **A polished terminal interface for the `hive` CLI**, in the style of `gh`, `npm` or `cargo`:
   colour, a live status line during runs (spinner, step, elapsed time, cost), tidy tool-call lines,
   the agent's Markdown rendered for the terminal, aligned tables, and interactive pickers when an
   argument is missing. Plain output stays exactly as it is today whenever stdout/stderr isn't a
   terminal, with `NO_COLOR`, or with `--json`.

## Files to touch

- `scripts/build-release.sh`
- `src/index.ts`
- `src/release.ts`
- `test/release.test.mjs`
- `src/tui.ts` (new)
- `src/render.ts`
- `src/cli.ts`
- `test/tui.test.mjs` (new)
- `test/cli.test.mjs`
- `README.md`
- `docs/CLI.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

### Part 1: web UI in the bundle

2. `scripts/build-release.sh`: run `npm run build:ui` before bundling (fail the release if it
   fails), then copy `ui/dist` to `"$app/ui/dist"` (so the bundle has `bin/`, `lib/`, `libexec/`,
   `ui/dist/`). Keep everything else as it is.

3. `src/index.ts`: find the UI folder in this order and use the first that exists:
   `process.env.HIVE_UI_DIR`; `join(process.env.HIVE_BUNDLE_ROOT, "ui", "dist")` when
   `HIVE_BUNDLE_ROOT` is set; `join(here, "..", "ui", "dist")` (today's rule, for source
   checkouts). Export a pure `export function uiDistCandidates(env: NodeJS.ProcessEnv, here: string):
   string[]` from a small module **`src/release.ts`** (it already deals with bundles) returning
   that ordered list, and use it in `index.ts`. Keep the existing warning when none exists.

4. `test/release.test.mjs`: test `uiDistCandidates` (order, with and without the two env vars).

### Part 2: polished CLI output

5. `src/tui.ts` (new), no new dependencies (use ANSI codes directly or `node:util`'s
   `styleText`):
   - `export function colorEnabled(stream: { isTTY?: boolean }, env = process.env): boolean`:
     false when `NO_COLOR` is set (any value), true when `FORCE_COLOR` is set to anything but `0`,
     otherwise `stream.isTTY === true`.
   - Style helpers taking an `enabled` flag (so tests can force it): `bold`, `dim`, `red`, `green`,
     `yellow`, `cyan`, `magenta`; each returns the text unchanged when disabled.
   - Symbols: `✓` done, `✗` failed, `■` stopped, `▸` tool, `●` running; with colour disabled they
     are still used only in TTY mode (plain mode keeps today's text).
   - `export function formatDuration(ms: number): string` (`4s`, `3m 12s`, `1h 02m`) and
     `export function formatCost(usd: number): string` (`$0.0123`).
   - `export function table(rows: string[][], o?: { header?: boolean; enabled?: boolean }): string`:
     aligned columns padded by visible width (strip ANSI codes when measuring), two spaces between
     columns, the header row bold and followed by nothing else.
   - `export class StatusLine` for stderr: `start(text)`, `update(text)`, `stop()`, and
     `print(line)` which clears the status line, writes the line, then redraws the status. It
     animates a braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, every 100 ms, timer `unref()`ed) only when the
     stream is a TTY; otherwise every method except `print` does nothing and `print` just writes.
     Truncate the status to the terminal width (`stream.columns`, default 80).
   - `export function renderMarkdownTerminal(text: string, enabled: boolean): string`: headings
     bold (and cyan for `#`/`##`), `**bold**` bold, `` `code` `` cyan, fenced code blocks dim and
     indented by two spaces, `- ` / `* ` bullets as `  • `, numbered lists kept, tables kept as
     text, links `[text](url)` as `text (url)`. With `enabled` false it returns the text unchanged.
   - `export async function select<T>(question: string, choices: { label: string; value: T;
     hint?: string }[], o?: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream }): Promise<T>`:
     an arrow-key picker (↑/↓ or k/j to move, Enter to choose, Ctrl+C or Esc to cancel, which
     throws `new Error("cancelled")`), drawn on the output stream with raw mode on the input and
     restored afterwards (also on error). Throws `"not a terminal"` when input isn't a TTY.
   - `export async function ask(question: string, o?: { input; output }): Promise<string>`: one
     line of text with readline. Throws `"not a terminal"` when input isn't a TTY.

6. `src/render.ts` and `src/cli.ts`, in TTY mode (colour enabled per `colorEnabled(process.stderr)`
   for the run views and `colorEnabled(process.stdout)` for tables):
   - **`hive run`, `hive new`, `hive continue`:** a `StatusLine` on stderr showing
     `<spinner> <step> · <elapsed> · <cost> · <n> tools`, where step is `Cloning`, `Waiting for a
     slot`, `Agent working`, `Reviewing (1/2)`, `Exporting`. Each finished step prints a line like
     `✓ Cloned owner/repo` / `✓ Agent finished` (via `StatusLine.print`). Tool calls print as
     `  ▸ bash  <command, first line, dimmed, truncated to the width>`; a failed tool as
     `  ✗ <tool>  …` in red. The agent's messages print with `renderMarkdownTerminal`. The final
     summary is one line: `✓ Done · 1 commit · 3m 12s · $0.0123` (green), `✗ Failed · <error first
     line>` (red), or `■ Stopped` (yellow), followed by the next-step hints that are printed today
     (`hive diff <run>`, `hive push <run>`), dimmed. The OpenRouter provider order and hive notes
     print as dim lines.
   - **`hive list`:** a `table` with columns `RUN`, `STATUS` (coloured: done green, failed red,
     aborted/stopped yellow, running cyan with `●`), `COMMITS`, `COST`, `AGE` (e.g. `2h ago`,
     `running 3m`), `REPO`.
   - **`hive doctor`:** each check as `✓ label  detail` (green ✓) or `✗ label  detail` plus the
     fix hint it prints today (red ✗).
   - **`hive keys list`:** a `table` (`PROVIDER`, `KEY`, `SOURCE`, `DEFAULT MODEL`, marking the
     default provider with `●`).
   - **Pickers (TTY input only):** `hive keys add` with no provider → `select` over providers;
     `hive keys default` with no provider → `select` over providers that have a key; `hive clean`
     with no run and no `--all` → `select` over finished runs (newest first, label = run name,
     hint = status and age); `hive run` / `hive new` with no prompt and no `-f` → `ask("What should
     the agent do?")`. Without a TTY these keep today's behaviour (usage error).
   - **Plain mode is unchanged:** when the relevant stream isn't a TTY, or `NO_COLOR` is set, or
     `--json` is given, every command prints exactly what it prints today (same text, same
     streams). Existing tests must pass without changing their expected output.

7. Tests:
   - `test/tui.test.mjs` (new): `colorEnabled` (NO_COLOR wins, FORCE_COLOR, TTY flag);
     `formatDuration`; `formatCost`; `table` alignment with and without colour (ANSI codes don't
     break the alignment); `renderMarkdownTerminal` with `enabled` false returns the input
     unchanged and with `enabled` true bolds a heading and bullets a list; `StatusLine` on a fake
     non-TTY stream writes only what `print` gets; `select` and `ask` reject with `not a terminal`
     on a non-TTY input; `select` on a fake TTY input (an object with `isTTY: true`, `setRawMode`,
     and emitted `keypress`/data events) returns the second choice after a down-arrow and Enter, and
     restores raw mode.
   - `test/cli.test.mjs`: one case that runs `hive list` with `FORCE_COLOR=1` on a temp
     `HIVE_RUNS_DIR` with one fake finished run and checks the output contains the `RUN` header and
     an ANSI escape; and one with `NO_COLOR=1` (or piped) that checks there's no ANSI escape.

8. Docs: `docs/CLI.md` — a short "Output" section: colours and the live status line in a terminal,
   plain text when piped or with `NO_COLOR`, `--json` for raw events, and the interactive pickers.
   `README.md` — nothing beyond what the CLI docs link already covers (leave it unless a command
   example becomes wrong).

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/tui.test.mjs test/release.test.mjs test/cli.test.mjs` exits 0 (after
  `npm run build`).
- Bundle check (Part 1), all from the repo root:
  `node scripts/keygen.mjs /tmp/k.pem > /tmp/k.pub && HIVE_SIGNING_KEY=/tmp/k.pem HIVE_RELEASE_SKIP_ROOTFS=1 npm run release`
  exits 0; then extract `release/*/hive-*-linux-x86_64.tar.gz` into a temp dir, check it contains
  `hive-<version>/ui/dist/index.html`, start
  `API_TOKEN=0123456789abcdef0123 HIVE_KEYS_FILE=/tmp/nokeys PORT=18080 <dir>/hive-<version>/bin/hive serve`
  in the background, and `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/ui/`
  prints `200`. Stop the server afterwards and delete the temp files and `release/`.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands; the bundle check is the one server this
  plan sets up. Never boot a hive VM, start `hive run`, or call GitHub/OpenRouter. If something
  outside Acceptance fails, note it in the report and finish.
- No new npm dependencies. Don't change `vm/`, `image/`, `src/sandbox.ts`, `src/runs.ts` run logic
  or `ui/`. `--json` output must stay byte-for-byte as it is.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- A full-screen dashboard, a pager for `hive diff`, colour in the web UI, Windows terminals.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
