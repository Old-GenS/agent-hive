## Goal

Let the web UI start, watch and switch between several runs at once. The server already runs up
to `MAX_CONCURRENT_SESSIONS` tasks in parallel; the UI only follows the run it just started. Add a
run list on the Runs page (every run the server knows about, with live status), keep **New run**
available while runs are going, and make a run reopenable by URL (`#runs/<sessionId>`), including
after a page reload.

## Files to touch

- `src/tasks.ts`
- `src/routes/sessions.ts`
- `ui/src/main.ts`
- `ui/src/app.css`
- `ui/src/bee.ts`
- `scripts/ui-smoke.mjs`
- `test/runs-list.test.mjs` (new)
- `README.md`
- `AGENTS.md`
- `.handoff/report.md`
- `.handoff/ui-*.png` (screenshots written by the smoke script)

## Steps

1. Run `npm ci`, then `cd ui && npm ci && cd ..`, then `bash vm/build.sh`.

2. `src/tasks.ts`:
   - `Task.toJSON()` adds `title`: the first non-empty line of `this.opts.prompt`, trimmed, cut to
     120 characters with `…` when longer (empty string if none).
   - Export `listTasks(): ReturnType<Task["toJSON"]>[]`: every task in the registry except those
     with `opts.ephemeral`, newest first by `createdAt`.

3. `src/routes/sessions.ts`: add `GET /runs` (inside the same authenticated plugin as the other
   session routes) returning `{ runs: listTasks(), capacity: capacity() }` (import `capacity` from
   `../tasks.js`).

4. `ui/src/bee.ts`: export `miniHive(state: BeeState | "idle"): SVGSVGElement`, a 20×20 inline SVG
   of the honeycomb cell (same hexagon path as the indicator, scaled to the 20 px viewBox) with
   class `mini-hive` and `data-state`. Built with `createElementNS`, `aria-hidden="true"`.

5. `ui/src/main.ts` and `ui/src/app.css`, **Runs page layout**:
   - Desktop (wider than 900 px): two columns, a run list on the left (`<aside class="runs-list"
     aria-label="Runs">`, 300 px) and the current view on the right (the New run form or a run).
     900 px and narrower: one column, the run list above the view, with at most 5 runs visible and
     a "Show all (N)" toggle.
   - The list starts with a **New run** button (`#newRunBtn`, primary). Below it, one item per run
     (`<a class="run-item" href="#runs/<id>">`), newest first:
     - `miniHive(state)` coloured by status: queued → outline, working (cloning, running,
       reviewing, pushing) → honey with the existing `honey-pulse` animation, done → filled honey,
       failed/aborted → grey (no animation under `prefers-reduced-motion`);
     - the run's `title` (one line, ellipsis), and under it in muted 13 px text: the repo as
       `owner/name` (or `new project <name>`, or `no repo`), the model, and either the elapsed time
       for a busy run or "<n> min ago" since `lastActivity` for a finished one;
     - the existing status pill (same labels and colours as the run view).
     - The selected run has `aria-current="page"` and the accent-soft background.
   - Empty list: a short muted line under New run: "No runs yet. Give the bees a task."
   - Fetch `GET /runs` when the Runs page opens, then every 3 seconds while the page is visible
     (`document.visibilityState === "visible"`); stop polling when leaving the Runs page. Re-render
     the list only when the data changed (compare a JSON string of the runs).

6. `ui/src/main.ts`, **routing and several runs**:
   - `#runs` shows the New run form; `#runs/<sessionId>` shows that run. Starting a run sets
     `location.hash = "#runs/" + sessionId` after `/prompt` returns. **New run** (in the list and
     in the run view) sets `#runs`. The form keeps the remembered provider, model and thinking.
   - Opening `#runs/<id>` (from the list, a link, or a reload): fetch `GET /status/<id>`; on 404
     show "This run is gone (the server restarted or it expired)." with a New run button. Otherwise
     build the run view from the status (title, repo, provider label, model, status), then connect
     the WebSocket exactly as today. The server replays the latest prompt's events on connect, so the
     timeline, the steps and the result rebuild themselves. After a `hive_done` arrives from the
     replay, if the status had `prUrl` / `issueUrl`, show the banner's PR/issue box in the `open`
     state with that URL (validated with the existing `PR_URL` / `ISSUE_URL` patterns).
   - Switching runs closes the previous run's WebSocket and destroys its bee indicator; runs keep
     going on the server.
   - The header bee: shown while any run in the latest `/runs` data is busy (not only the run being
     viewed). Its accessible text says "<n> run(s) in progress" and the header bee's `title` says
     the same.

7. `scripts/ui-smoke.mjs`: keep every existing check (adjust selectors only where the layout change
   requires it, e.g. clicking `#newRunBtn` instead of a "New run" text button). Add, after the
   existing run checks and before Settings:
   - `page.route("**/runs", ...)` answering two runs: `{ sessionId: "list-a", title: "Fix the login form", status: "running", repo: "https://github.com/demo/repo.git", model: "deepseek-flash", provider: "deepseek", createdAt: Date.now() - 60000, lastActivity: Date.now() }` and
     `{ sessionId: "list-b", title: "code review and next steps", status: "idle", repo: "https://github.com/demo/repo.git", model: "deepseek-flash", provider: "deepseek", createdAt: Date.now() - 600000, lastActivity: Date.now() - 300000, prUrl: "https://github.com/demo/repo/pull/9" }`, with `capacity: { running: 1, queued: 0, max: 3 }`;
     `page.route("**/status/list-b", ...)` answering list-b's object; a `routeWebSocket` for
     `/events/list-b` that sends `hive_status` running then `hive_done` idle with `resultBranch:
     "hive/listb000"`, `commitsPushed: 1`, `repoSlug: "demo/repo"` and one-file `changes`. Reload so
     the WebSocket route applies.
   - Go to `#runs`; assert two `.run-item`s, the first titled "Fix the login form"; assert a
     `.header-bee` exists (list-a is running).
   - Click the list-b item; assert `location.hash === "#runs/list-b"`, the Done banner appears, and
     `#prLink` has `href` `https://github.com/demo/repo/pull/9` (restored from the status).
   - Save `.handoff/ui-runs-list.png`; reload the page and assert the list-b run view is shown
     again; then unroute everything, go to `#runs` and continue with Settings.

8. `test/runs-list.test.mjs` (new), `node:test` style: before importing from `dist/`, set
   `HIVE_DOTENV_PATH` and `HIVE_KEYS_FILE` to missing files in a temp dir, `WORKSPACE` to a temp dir,
   and `DEEPSEEK_API_KEY=sk-test`. Import `createTask`, `listTasks`, `destroyTask` from
   `../dist/tasks.js`. Create a task with prompt `"First line\nmore"`, another with a 200-char first
   line, and an `ephemeral: true` task (do not run them). Assert `listTasks()` has the two
   non-ephemeral tasks newest first, titles `"First line"` and a 121-char string ending in `…`.
   Destroy all three in a `finally`.

9. `README.md`: in the web UI section, describe the run list, reopening runs by URL, starting runs
   while others are going, and that the list only covers runs since the server last started; add
   `GET /runs` to the API table. `AGENTS.md`: update the `src/routes/sessions.ts` row (`/runs`).

## Acceptance

- `npm test` exits 0 and includes `test/runs-list.test.mjs` passing.
- `npm run build:ui` exits 0.
- `npm i --no-save playwright-core@1.49.1 && node scripts/ui-smoke.mjs` prints `ui-smoke: ok`
  and exits 0, and `.handoff/ui-runs-list.png` exists.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies (`npm ci`, `npm i --no-save`) and
  temporary files outside the repo are fine.
- The only checks to run are the **Acceptance** commands. Don't write or run other end-to-end
  tests; never let a script reach the real `/prompt` endpoint or start an agent. If something
  outside Acceptance fails, note it in the report and finish.
- `/runs` stays in the authenticated scope. Agent and task text in the UI is rendered as text only
  (`el()` / `textContent`). No new dependencies, no emoji.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Keeping runs across server restarts, splitting one goal into parallel tasks (swarm), deleting
  runs from the UI, showing timelines of earlier prompts in a multi-prompt session, the CLI.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
