## Goal

Show that a run is happening with an animated bee that fits the hexagon/hive theme:

- In the run view, an activity row with a honeycomb cell and a bee: the bee flies around the cell
  while the microVM is working, hovers while queued, lands on a filled cell when done, and turns
  grey when the run failed or was stopped. Next to it: a status line and an elapsed timer.
- While a run is busy, a small bee next to **Runs** in the header.
- Respect `prefers-reduced-motion` (no flying or wing flutter).
- Fix the phone header so it stays on one line at 390 px.

## Files to touch

- `ui/src/bee.ts` (new)
- `ui/src/main.ts`
- `ui/src/app.css`
- `scripts/ui-smoke.mjs`
- `.handoff/report.md`
- `.handoff/ui-run-working.png`, `.handoff/ui-run-done.png`, `.handoff/ui-phone.png`,
  `.handoff/ui-desktop.png`, `.handoff/ui-settings.png` (screenshots written by the smoke script)

## Steps

1. Run `npm ci`, then `cd ui && npm ci && cd ..`, then `bash vm/build.sh`.

2. `ui/src/app.css`: add tokens to `:root`: `--honey: #E8A317; --honey-soft: #FCEFD2;` and in the
   dark `@media (prefers-color-scheme: dark)` block: `--honey: #F2B53A; --honey-soft: #3A2C0E;`.

3. `ui/src/bee.ts` (new). Export:

   ```ts
   export type BeeState = "queued" | "working" | "done" | "failed" | "stopped";
   export interface BeeIndicator {
     root: HTMLElement;
     set(state: BeeState, label: string): void;
     destroy(): void;
   }
   export function createBeeIndicator(): BeeIndicator;
   export function headerBee(): HTMLElement;
   ```

   - `createBeeIndicator()` returns `root` = `<div class="bee-indicator" data-state="queued">`
     containing:
     - `<div class="bee-stage" aria-hidden="true">`: one inline `<svg viewBox="0 0 96 96" width="96" height="96">` with
       - a honeycomb cell: hexagon path `M48 18l26 15v30L48 78 22 63V33z`, `fill="var(--honey-soft)"`,
         `stroke="var(--honey)"`, `stroke-width="3"`, `stroke-linejoin="round"`, class `bee-cell`;
       - inside it a honey fill: the same hexagon scaled to 60% around the centre
         (`transform="translate(48 48) scale(0.6) translate(-48 -48)"`), `fill="var(--honey)"`,
         class `bee-honey`;
       - a `<g class="bee-flight">` (rotates around the cell centre) containing a `<g class="bee">`
         placed at the top of the orbit (`transform="translate(48 8)"`) with: two wings (ellipses
         `rx="6" ry="4"` at `(-4,-5)` and `(4,-5)`, `fill="var(--surface)"`, `stroke="var(--text-3)"`,
         `stroke-width="1"`, `opacity="0.9"`, class `bee-wing`), a body ellipse `rx="7" ry="5"`
         `fill="var(--honey)"`, two stripes (`rect` 2 px wide, `fill="var(--text)"`, at x `-2` and
         `2`, clipped to the body with a `clipPath`), a head circle `r="3"` at `(8,0)`
         `fill="var(--text)"`.
       The SVG is built with `document.createElementNS` (no `innerHTML`).
     - `<div class="bee-text">` with `<span class="bee-label" role="status" aria-live="polite">`
       and `<span class="bee-time" aria-hidden="true">` (format `m:ss`, or `h:mm:ss` after an hour).
   - `set(state, label)`: sets `root.dataset.state`, sets the label's `textContent` only when the
     state or label changed (so screen readers aren't spammed). The timer starts at the first
     `set` call, updates every second with `setInterval` while the state is `queued` or `working`,
     and stops (keeping the final time) on `done`, `failed` or `stopped`.
   - `destroy()` clears the interval.
   - `headerBee()` returns `<span class="header-bee">` with a 16×16 inline SVG of the same bee
     (`aria-hidden="true"`) and a visually hidden `<span class="sr-only">Run in progress</span>`.

4. `ui/src/app.css`, bee styles:
   - `.bee-indicator`: flex row, `align-items: center`, `gap: 16px`, `padding: 12px 0`.
     `.bee-stage` 96×96, `flex-shrink: 0`. `.bee-text`: column, `gap: 2px`; `.bee-label` 15 px,
     weight 600; `.bee-time` 13 px, `color: var(--text-3)`, `font-variant-numeric: tabular-nums`.
   - Use `transform-box: view-box; transform-origin: 48px 48px;` on `.bee-flight` and
     `transform-box: fill-box; transform-origin: center;` on `.bee` and `.bee-wing`.
   - `@keyframes bee-orbit { to { transform: rotate(360deg); } }` and
     `@keyframes bee-upright { to { transform: translate(48px, 8px) rotate(-360deg); } }` with the
     `.bee` start state `transform: translate(48px, 8px)` (so the bee stays upright while orbiting);
     `@keyframes bee-flutter { 0%,100% { transform: scaleY(1); } 50% { transform: scaleY(0.35); } }`;
     `@keyframes bee-bob { 0%,100% { transform: translate(48px, 8px); } 50% { transform: translate(48px, 4px); } }`;
     `@keyframes honey-pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 0.9; } }`.
   - States:
     - `[data-state="working"]`: `.bee-flight` `animation: bee-orbit 3.2s linear infinite`;
       `.bee` `animation: bee-upright 3.2s linear infinite`; `.bee-wing`
       `animation: bee-flutter 0.12s linear infinite`; `.bee-honey`
       `animation: honey-pulse 2.4s ease-in-out infinite`.
     - `[data-state="queued"]`: no orbit; `.bee` `animation: bee-bob 1.6s ease-in-out infinite`;
       wings flutter; `.bee-honey` `opacity: 0.25`.
     - `[data-state="done"]`: no animation; the bee sits on top of the cell
       (`.bee { transform: translate(48px, 18px); }`); `.bee-honey` `opacity: 1`.
     - `[data-state="failed"]`, `[data-state="stopped"]`: no animation; `.bee-indicator`
       `filter: grayscale(1)`; `.bee-honey` `opacity: 0.15`; `.bee-label` `color: var(--text-2)`.
   - `@media (prefers-reduced-motion: reduce)`: every `.bee-indicator *` and `.header-bee *` gets
     `animation: none !important`.
   - `.header-bee`: inline-flex, 16×16, `margin-left: 6px`, vertically centred; its wings flutter
     with `bee-flutter 0.12s linear infinite`.
   - `.sr-only`: the standard visually-hidden rule (if not already defined).
   - Phone header fix, `@media (max-width: 640px)`: the header stays one row with no wrapping —
     hide the user name (`.user-name { display: none; }` or the existing class for it), reduce
     the header gap to 8 px and nav button padding to `0 10px`; at 390 px the header must be a
     single row at most 64 px tall with no horizontal scroll. Use the header's existing class
     names in `main.ts`; add a class if the user-name element has none.

5. `ui/src/main.ts`:
   - Import `createBeeIndicator`, `headerBee` and `BeeState` from `./bee.js`.
   - In `buildRunView()`, create the indicator, keep it on `runUi` (add `bee: BeeIndicator` to
     `RunUi`), and insert `bee.root` in the run head card between the meta line and the toolbar.
     Destroy the previous indicator when a new run view is built and in `newRun()`.
   - In `syncRunUi()`, map the run status to the bee:
     `queued` → `("queued", "Waiting for a free microVM")`;
     `cloning` → `("working", "Cloning the repo")`;
     `running` → `("working", "Agent working in the microVM")`;
     `reviewing` → `("working", "Reviewing the changes")`;
     `pushing` → `("working", "Pushing changes")`;
     `idle` → `("done", "Done")`; `failed` → `("failed", "Failed")`;
     `aborted` → `("stopped", "Stopped")`.
   - Header: while `run?.busy` is true, append one `headerBee()` inside the **Runs** nav button
     (keep a reference; never add two); remove it when the run is no longer busy. Call this from
     `syncRunUi()`.

6. `scripts/ui-smoke.mjs`: keep every existing check and screenshot, and add, after the desktop
   Runs checks and before Settings, a run-view check that never reaches the real server's
   `/prompt`:
   - `await page.route("**/prompt", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessionId: "demo-session", status: "queued", repo: null, provider: "deepseek", model: "deepseek-v4-pro" }) }));`
   - `await page.route("**/events/demo-session/ticket", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "demo" }) }));`
   - `let demoSocket; await page.routeWebSocket(/\/events\/demo-session/, (ws) => { demoSocket = ws; ws.send(JSON.stringify({ type: "hive_status", status: "running" })); ws.send(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } })); });`
     (do not call `ws.connectToServer()`).
   - Fill `#task` with `demo task`, click `#startBtn`, wait for
     `.bee-indicator[data-state="working"]`; assert `.bee-label` text is
     `Agent working in the microVM`; assert a `.header-bee` exists; wait 1500 ms; save
     `.handoff/ui-run-working.png`.
   - `demoSocket.send(JSON.stringify({ type: "hive_done", status: "idle", usage: { cost: 0.0123 } }))`;
     wait for `.bee-indicator[data-state="done"]`; assert no `.header-bee` exists; save
     `.handoff/ui-run-done.png`.
   - Reduced motion: `await page.emulateMedia({ reducedMotion: "reduce" })`, then assert
     `getComputedStyle(document.querySelector(".bee-flight")).animationName === "none"`; then
     `await page.emulateMedia({ reducedMotion: "no-preference" })`.
   - `await page.unroute("**/prompt")` and `await page.unroute("**/events/demo-session/ticket")`,
     click **New run**, wait for `#provider`, then continue with the existing Settings checks.
   - In the existing phone check, also assert that the header element's bounding box height is at
     most 64 px.

## Acceptance

- `npm test` exits 0.
- `npm run build:ui` exits 0.
- `npm i --no-save playwright-core@1.49.1 && node scripts/ui-smoke.mjs` prints `ui-smoke: ok`
  and exits 0, and `.handoff/ui-run-working.png`, `.handoff/ui-run-done.png`,
  `.handoff/ui-phone.png`, `.handoff/ui-desktop.png` and `.handoff/ui-settings.png` exist.
- `grep -n "innerHTML" ui/src/bee.ts` prints nothing.
- `git status --short` lists no files other than those in **Files to touch** (screenshots are
  under `.handoff/`).

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies (`npm ci`, `npm i --no-save`) and
  temporary files outside the repo are fine.
- The only checks to run are the **Acceptance** commands. Don't write or run other end-to-end
  tests, and never let a script reach the real `/prompt` endpoint (no real agent runs). If
  something outside Acceptance fails, note it in the report and finish.
- No new dependencies, no emoji in the UI, no images or external assets: the bee is inline SVG.
- No changes to server code (`src/`), the API, or the security invariants in `AGENTS.md`.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Sound, a run list, notifications, changes to the timeline items, the Settings page, the CLI,
  `README.md`.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
