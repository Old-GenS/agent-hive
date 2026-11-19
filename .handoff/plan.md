## Goal

Replace the old dark chat UI in `ui/` with a new web UI in the look of the hive design mockup
(light, clean, Inter-style type, blue accent, hexagon logo), with:

- a header with **Runs** and **Settings**;
- a **New run** form with a real model picker: a text box with a per-provider dropdown list
  (`<datalist>`) filled from a new `GET /api/models?provider=<id>` endpoint, so the user can pick
  from the list or type any model ID;
- a **run view** that shows the agent's progress as a timeline, with Stop, follow-up messages and
  a result banner;
- a **Settings › API keys** page that shows each provider's key status, default model and which
  provider is the default (read-only for now).

The server API stays as it is apart from the new `/api/models` endpoint.

## Files to touch

- `src/models.ts` (new)
- `src/routes/providers.ts`
- `ui/index.html`
- `ui/src/main.ts`
- `ui/src/app.css`
- `ui/src/util.ts`
- `ui/src/github-panel.ts` (delete)
- `scripts/ui-smoke.mjs` (new)
- `test/models.test.mjs` (new)
- `README.md`
- `AGENTS.md`
- `.handoff/report.md`
- `.handoff/ui-desktop.png`, `.handoff/ui-phone.png`, `.handoff/ui-settings.png` (new, screenshots)

## Steps

1. Run `npm ci`, then `cd ui && npm ci && cd ..`.

2. `src/models.ts` (new). Export:

   ```ts
   export const STATIC_MODELS: Record<string, string[]> = {
     deepseek: ["deepseek-v4-pro", "deepseek-flash"],
     zai: ["glm-5.3"],
     anthropic: [],
     openai: [],
   };
   export async function listModels(provider: string, fetchImpl: typeof fetch = fetch): Promise<string[]>
   ```

   - Unknown provider (not a key of `PROVIDERS` from `./config.js`): throw `Error("Unknown provider")`.
   - `openrouter`: GET `https://openrouter.ai/api/v1/models` with `fetchImpl` and a 10 s timeout
     (`AbortSignal.timeout(10_000)`). The response is `{ data: [{ id: string, ... }] }`. Return the
     `id`s sorted alphabetically, de-duplicated. Cache the list in a module variable for 1 hour.
     On any error (network, non-2xx, bad JSON), return `["xiaomi/mimo-v2.6-flash"]` and do not cache.
     Export `clearModelCache()` that empties the cache (for tests).
   - Other providers: return `STATIC_MODELS[provider]`.
   - In every case, if `effectiveModel(provider)` (from `./config.js`) is set and not in the list,
     put it first.

3. `src/routes/providers.ts`: add
   `app.get("/api/models", { schema: { querystring: { type: "object", required: ["provider"], properties: { provider: { type: "string", maxLength: 50 } } } } }, ...)`
   returning `{ provider, models }` from `listModels`, or status 400 `{ error: "Unknown provider" }`
   when it throws. It stays inside the authenticated scope (the plugin is already registered there
   in `src/index.ts`; do not change `src/index.ts`).

4. Delete `ui/src/github-panel.ts`. Rewrite `ui/index.html` to a minimal shell: doctype, `lang="en"`,
   charset, viewport, `<title>hive</title>`, `<div id="app"></div>`,
   `<script type="module" src="/src/main.ts"></script>`. No inline `<style>`; no external fonts or
   CDNs.

5. `ui/src/app.css`: all styles, imported at the top of `main.ts` with `import "./app.css";`.
   - Tokens on `:root`: `--bg: #F4F4F1; --surface: #FFFFFF; --surface-2: #F7F7F5; --border: #DCDDE0;
     --border-strong: #C9CBD0; --text: #15171C; --text-2: #3B4049; --text-3: #555B66;
     --accent: #1F5FD1; --accent-hover: #174AA6; --accent-soft: #E8EFFC; --ok: #1E7A46;
     --ok-soft: #E6F4EC; --warn: #8A5100; --warn-soft: #FFF4E0; --danger: #B42318;
     --danger-soft: #FDECEA; --radius: 8px; --radius-lg: 12px;`
     and a dark set under `@media (prefers-color-scheme: dark)`: `--bg: #0F1115; --surface: #171A20;
     --surface-2: #1D2128; --border: #2A2F38; --border-strong: #3A404B; --text: #ECEDEF;
     --text-2: #B8BCC4; --text-3: #8E939C; --accent: #6B9BFF; --accent-hover: #8DB2FF;
     --accent-soft: #1C2A45; --ok: #5CC98A; --ok-soft: #15301F; --warn: #F0B45A;
     --warn-soft: #33270F; --danger: #FF7A6E; --danger-soft: #3A1714;`.
   - Font: `font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
     headings `"Space Grotesk", Inter, ui-sans-serif, system-ui, sans-serif`, weight 600.
     Monospace: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
   - `body { margin: 0; background: var(--bg); color: var(--text); }`. Buttons and inputs at least
     44 px tall; visible `:focus-visible` outline `2px solid var(--accent)` with 2 px offset.
   - Layout must work at 390 px wide: no horizontal scroll, form fields stack to one column,
     16 px side padding.
   - No emoji anywhere in the UI; icons are inline SVG with `aria-hidden="true"`.

6. `ui/src/util.ts`: keep `STORAGE_KEY`, `serverUrl`, `getToken`, `setToken`, `esc`, `api`. Add
   `el(tag, attrs?, ...children)`: creates an element, sets attributes (`class`, `id`, `type`,
   `for`, `aria-*`, etc.) with `setAttribute`, appends string children as text nodes and element
   children as-is. Use `el` or `textContent` for all server, GitHub and agent data. `innerHTML` may
   only take fixed markup written in the source (no interpolated values) or the output of
   `formatContent` (step 8).

7. `ui/src/main.ts`, structure:
   - **Login:** a centred card: hexagon logo + "hive", "Enter your API token", password input,
     **Continue** button, error text "That token didn't work" when `/api/user` is not ok. Store the
     token as today (`localStorage` under `STORAGE_KEY`, wrapped in try/catch).
   - **Header:** logo (the mockup's hexagon SVG:
     `<svg width="24" height="24" viewBox="0 0 28 28" aria-hidden="true"><path d="M14 3l9.5 5.5v11L14 25l-9.5-5.5v-11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 9l4.8 2.8v5.4L14 20l-4.8-2.8v-5.4z" fill="var(--accent)"/></svg>`),
     the word "hive", a `<nav aria-label="Main">` with two buttons **Runs** and **Settings**
     (`aria-current="page"` on the active one), and on the right the user's name and **Log out**.
     Views switch without reloading; the active view is kept in `location.hash` (`#runs`,
     `#settings`), default `#runs`.
   - On login, fetch `/api/providers` once and keep it in a module variable `providers`
     (shape as returned by the server: `default {provider, providerSource, model, modelSource, thinking}`
     and `providers [{id, label, hasKey, model}]`). If it fails, use an empty list and show the
     form with a warning "Couldn't load providers".

8. **Runs view, New run form** (a white card, max width 880 px, centred):
   - `<h1>New run</h1>` and one line: "The agent works on a copy of the repo inside a throwaway VM."
   - **Task**: `<label for="task">`, `<textarea id="task" rows="5">`, placeholder
     "Describe what the agent should do". Ctrl+Enter or Cmd+Enter starts the run.
   - **Repository** `#repo` (optional, placeholder `owner/name, or leave empty`) with
     `list="repoOptions"`; fill `<datalist id="repoOptions">` from `/api/github/repos` (each repo's
     `nameWithOwner || fullName || name`). If that request fails, leave the datalist empty and show
     nothing. **Branch** `#branch` (optional, placeholder `default branch`).
   - **Provider** `<select id="provider">`: one option per entry of `providers.providers`, value
     `id`, text `label`; without a key the text is `<label> (no key)` and the option is `disabled`.
     Pre-select `providers.default.provider`. If no provider has a key, disable the Start button and
     show "Add an API key first (see Settings)".
   - **Model** `<input id="model" list="modelOptions">` with `<datalist id="modelOptions">`. On
     load and whenever the provider changes: clear the input, set its placeholder to that
     provider's `model` from `providers` (or `model ID` when null), fetch
     `/api/models?provider=<id>` and fill the datalist with `<option value="<id>">`. A hint under
     it: "Pick from the list or type any model ID. Empty uses the default."
   - **Thinking** `<select id="thinking">`: first option value `""` text
     `Default (<providers.default.thinking>)`, then `off minimal low medium high xhigh`.
   - **Review** `<select id="review">`: `0` "No review", `1` "1 review cycle", `2` "2 review cycles";
     only sent when a repo is set.
   - Desktop: Repository and Branch on one row; Provider, Model, Thinking, Review in a 2×2 grid.
     At 390 px everything is one column.
   - **Start run** (primary button). On click, POST `/prompt` with `prompt`, and only the non-empty
     fields: `repo`, `branch` (only with repo), `provider`, `model`, `thinkingLevel`,
     `reviewCycles` (only with repo and > 0). On a non-2xx response, show the server's `error`
     in a red alert above the button and keep the form filled.

9. **Runs view, run view** (replaces the form once `/prompt` returns a `sessionId`):
   - A header card: the first line of the task (max 120 chars), then a meta line
     `<repo or "no repo"> · <provider label> · <model>` from the `/prompt` response, and a status
     pill (`Queued`, `Cloning`, `Working`, `Reviewing`, `Pushing`, `Done`, `Failed`, `Stopped`)
     using the ok/warn/danger/accent soft colours.
   - **Stop** button while busy (POST `/abort/<id>`), **New run** button when not busy (closes the
     socket and returns to the form, keeping the provider/model/thinking choices).
   - A timeline (`<ol class="timeline">`): connect the WebSocket exactly as the old `connect()` did
     (POST `/events/<id>/ticket`, then `ws(s)://…/events/<id>?ticket=…`) and add items:
     - `hive_status` → a small status item (`Queued (running/max sandboxes busy)`,
       `Cloning the repo`, `Agent working in the VM`, `Review cycle n of m`, `Pushing changes`) and
       update the pill;
     - `message_start`/`message_update` (`assistantMessageEvent.type === "text_delta"`)/`message_end`
       for the assistant role → one assistant item per message, its text rendered with
       `formatContent` (keep the old function: escape first, then code fences, inline code, bold,
       newlines);
     - `tool_execution_start` → a compact tool item: tool name in bold and the command or path
       (`args.command ?? args.path ?? args.file_path`, first 200 chars) in monospace;
     - `tool_execution_end` with `isError` → mark the last tool item with a red "failed" label;
     - `hive_done` → a result banner: on `idle`, "Done" plus "Pushed N commit(s) to <branch>" when
       `resultBranch` is set, plus the cost `$x.xxxx` when `usage.cost > 0`; otherwise "Failed" or
       "Stopped" with `error`. Then set busy off and close the socket.
     - If the socket closes while busy, add "Lost the live stream; the run may still be going."
   - A follow-up box under the timeline (textarea + **Send**), enabled when not busy: POST
     `/prompt` with `{ prompt, sessionId }`, add the text as a user item, reconnect the socket.
   - Auto-scroll to the newest item only when the user is already near the bottom.

10. **Settings view:** a left settings nav (on phones, above the content) with one entry
    **API keys** (`aria-current="page"`), and the content:
    - `<h1>API keys</h1>`, then "A run only gets the key of the provider it uses, passed into its VM
      for that run."
    - A table (a real `<table>` inside a horizontally scrollable wrapper on phones) with columns
      **Provider**, **Default model**, **Key**, **Default**: one row per provider; Key shows a
      green "Key set" pill or a grey "No key" pill; Default shows an accent "Default" pill on the
      default provider, with a second line in muted text: `DEFAULT_PROVIDER` or
      `first provider with a key`, from `providerSource`. Default model shows the model or
      "none (set one per run)".
    - A muted card "Changing keys": "Keys are read from environment variables such as
      `OPENROUTER_API_KEY`, or from `~/.config/agent-hive/env` for the CLI and `.env` for the
      server. Set `DEFAULT_PROVIDER` and `DEFAULT_MODEL` there to change the defaults. Adding,
      testing and switching keys from this page is coming." (with the variable names in `<code>`).

11. `scripts/ui-smoke.mjs` (new), a check script run only by Acceptance. It:
    - starts the server: `spawn(process.execPath, ["dist/index.js"], { env: { ...process.env, API_TOKEN: "smoke-token-0123456789abcdef", PORT: "18123", HOST: "127.0.0.1", WORKSPACE: <mkdtemp dir>, DEEPSEEK_API_KEY: "sk-smoke", OPENROUTER_API_KEY: "sk-smoke", HIVE_DOTENV_PATH: "/nonexistent" } })`,
      waits until `GET http://127.0.0.1:18123/health` answers (max 20 s);
    - loads `playwright-core` (installed by Acceptance with `--no-save`) and launches Chromium with
      `executablePath: "/usr/lib64/chromium-browser/chromium-browser"` and
      `args: ["--no-sandbox", "--headless=new"]`;
    - desktop page 1280×800: open `http://127.0.0.1:18123/ui/`, fill the token, click Continue,
      wait for `#provider`; assert: `#provider` has an enabled option `deepseek` and a disabled
      option `zai`; `#modelOptions` gets at least one `option` within 10 s after selecting
      `deepseek`; `#model` placeholder is `deepseek-v4-pro`; no element's text contains any emoji
      (check `document.body.innerText` against `/\p{Extended_Pictographic}/u`); save
      `.handoff/ui-desktop.png`;
    - click **Settings**; assert the table has 5 body rows and one "Default" pill; save
      `.handoff/ui-settings.png`;
    - phone page 390×844 on `#runs`: assert
      `document.documentElement.scrollWidth <= 390`; save `.handoff/ui-phone.png`;
    - prints `ui-smoke: ok` and exits 0; on any failed assertion prints it and exits 1; always kills
      the server.
    It must not click **Start run**.

12. `test/models.test.mjs` (new), `node:test` style like the other tests. Before importing from
    `dist/`, set `HIVE_DOTENV_PATH` to a missing file and delete `DEFAULT_MODEL`. Tests:
    - deepseek returns `["deepseek-v4-pro", "deepseek-flash"]`;
    - openrouter with a fake `fetchImpl` returning `{ data: [{ id: "b/x" }, { id: "a/y" }, { id: "b/x" }] }`
      returns `["xiaomi/mimo-v2.6-flash", "a/y", "b/x"]` (default first, then sorted, de-duplicated);
      call `clearModelCache()` before it;
    - openrouter with a `fetchImpl` that rejects returns `["xiaomi/mimo-v2.6-flash"]`;
    - an unknown provider rejects with `/Unknown provider/`.

13. `README.md`: replace the description of the old web UI (chat panel, GitHub tab) with a short
    description of the new one (Runs: new-run form with a model list per provider, live timeline,
    Stop, follow-ups; Settings › API keys: key status and defaults, read-only for now), and add a
    row to the API table after `/api/providers`:
    `| GET | \`/api/models?provider=\` | Models to offer for a provider (OpenRouter's live list, a fixed list for the others) |`.
    Note under it that `npm run build:ui` builds the UI into `ui/dist`.

14. `AGENTS.md`: in the Layout table, change the `src/routes/providers.ts` row to
    `` `/api/providers` and `/api/models` for the UI `` and add a row
    `| \`src/models.ts\` | Model lists per provider (OpenRouter's live list, cached 1 h) |` and update
    the `ui/` row to `Vite + vanilla TS web UI (Runs, Settings), built to \`ui/dist\``.

## Acceptance

- `npm test` exits 0 and includes the four tests from `test/models.test.mjs` passing.
- `npm run build:ui` exits 0.
- `npm i --no-save playwright-core@1.49.1 && node scripts/ui-smoke.mjs` prints `ui-smoke: ok`
  and exits 0, and `.handoff/ui-desktop.png`, `.handoff/ui-phone.png` and
  `.handoff/ui-settings.png` exist.
- `grep -rn "innerHTML" ui/src` shows only fixed markup or `formatContent(...)` results.
- `test -e ui/src/github-panel.ts` exits 1.
- `git diff --stat` and `git status --short` list no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies (`npm ci`, `npm i --no-save`,
  `dnf install`) and temporary files outside the repo are fine.
- The only checks to run are the **Acceptance** commands. Don't write or run other end-to-end
  tests, and don't start a real agent run (never POST `/prompt` from a script). If something
  outside Acceptance fails, note it in the report and finish.
- No new runtime or dev dependencies in `package.json` or `ui/package.json`; no UI framework, no
  Tailwind, no external fonts or CDNs.
- Keep the server API and the security invariants in `AGENTS.md` (every API route stays in the
  authenticated scope; untrusted data rendered as text only).
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Adding, testing, removing keys or changing the default from the UI (`hive keys`), the first-run
  onboarding screens, a list of past runs, the GitHub fork button, file browsing, `landing.html`,
  any change to the CLI.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
