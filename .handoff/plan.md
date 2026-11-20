## Goal

Manage provider API keys from the web UI (Settings › API keys) and the CLI (`hive keys`): list them
masked, add a key (tested before it is saved), test a key, make a provider the default, and remove
a saved key. Saved keys live in one private file, `~/.config/agent-hive/env` (mode 600), read by
both the CLI and the server. Variables exported in the environment still win over saved keys.

## Files to touch

- `src/keys.ts` (new)
- `src/config.ts`
- `src/routes/keys.ts` (new)
- `src/index.ts`
- `src/cli.ts`
- `ui/src/main.ts`
- `ui/src/app.css`
- `ui/vite.config.ts`
- `scripts/ui-smoke.mjs`
- `test/keys.test.mjs` (new)
- `README.md`
- `AGENTS.md`
- `docs/GUI.md`
- `.handoff/report.md`
- `.handoff/ui-*.png` (screenshots written by the smoke script)

## Steps

1. Run `npm ci`, then `cd ui && npm ci && cd ..`, then `bash vm/build.sh`.

2. `src/config.ts`:
   - As the first statement after the imports, before `dotenv.config(...)`, capture the variables
     that came from the real environment: `export const shellEnv: Readonly<Record<string, string | undefined>> = { ...process.env };`.
   - Export `keysFilePath()`: `process.env.HIVE_KEYS_FILE || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-hive/env")`,
     read at call time.
   - Replace `providerKey(provider)` with a version built on `keySource` from `src/keys.ts`
     (step 3): it returns the value of the first `hostEnv` name that has one, looking in this
     order: `shellEnv`, the keys file, then `process.env` (which includes a server `.env`).
   - Add and export `setting(name: string): string | undefined` with the same order (shellEnv, keys
     file, process.env), returning `undefined` for empty strings.
   - `resolveProvider()` reads `setting("DEFAULT_PROVIDER")` instead of `process.env.DEFAULT_PROVIDER`;
     `effectiveModel()` reads `setting("DEFAULT_MODEL")` instead of `config.defaultModel`;
     `providerInfo()` uses `setting("DEFAULT_PROVIDER")` / `setting("DEFAULT_MODEL")` for its
     `providerSource` / `modelSource` checks. Keep `config.defaultModel` as is (other code may read
     it) but nothing in this task should rely on it.
   - `config.ts` must not import from `src/keys.ts` in a way that creates an import cycle problem:
     put the file reading/parsing in `src/keys.ts` with no import of `config.ts`, and import
     `keysFilePath` into `keys.ts` only if it does not import back; otherwise define
     `keysFilePath()` in `src/keys.ts` and re-export it from `config.ts`.

3. `src/keys.ts` (new). No import of `src/config.ts` (see step 2). Export:
   - `readKeysFile(path = keysFilePath()): Record<string, string>`: parses the file with
     `dotenv.parse`; returns `{}` when it does not exist. Cache by path + `mtimeMs` + size so
     repeated calls are cheap and edits made by another process are picked up.
   - `setKeysFileValue(name: string, value: string | null, path = keysFilePath()): void`: sets
     (or, with `null`, removes) one `NAME=value` line, keeping every other line and comment as it
     was. `name` must match `/^[A-Z][A-Z0-9_]*$/`; `value` must match `/^[\x21-\x7E]{1,400}$/`
     (printable ASCII, no spaces or newlines) and must not contain `"`, `'`, `#`, `\` or `` ` ``;
     otherwise throw. Create the folder with mode 0o700 if missing. Write to a temp file in the same
     folder with mode 0o600, then `renameSync` over the target; afterwards `chmodSync(path, 0o600)`.
     Invalidate the read cache.
   - `maskKey(key: string): string`: keys of 12+ chars → first 6 (or fewer so at least 4 stay
     hidden) + `…` + last 4; shorter keys → `…` + last 2. Never returns the whole key.
   - `type KeySource = "environment" | "saved" | "env-file"`.
   - `keySource(names: string[], shellEnv, processEnv, fileValues): { value: string; source: KeySource; name: string } | undefined`:
     the lookup order from step 2 (shellEnv → `"environment"`, keys file → `"saved"`,
     processEnv → `"env-file"`).
   - `testKey(provider: string, key: string, fetchImpl: typeof fetch = fetch): Promise<{ status: "works" | "refused" | "unchecked"; detail: string }>`:
     one GET with a 10 s timeout (`AbortSignal.timeout(10_000)`), no request body:
     - deepseek: `https://api.deepseek.com/models`, `Authorization: Bearer <key>`
     - openrouter: `https://openrouter.ai/api/v1/key`, `Authorization: Bearer <key>`
     - zai: `https://api.z.ai/api/coding/paas/v4/models`, `Authorization: Bearer <key>`
     - anthropic: `https://api.anthropic.com/v1/models`, headers `x-api-key: <key>` and
       `anthropic-version: 2023-06-01`
     - openai: `https://api.openai.com/v1/models`, `Authorization: Bearer <key>`
     2xx → `works` / `"The provider accepted the key"`; 401 or 403 → `refused` /
     `"The provider refused the key (HTTP <n>)"`; any other status → `unchecked` /
     `"Couldn't check the key (HTTP <n>)"`; a network error or timeout → `unchecked` /
     `"Couldn't reach the provider"`. Unknown provider → throw. Never include the key in `detail`.

4. `src/routes/keys.ts` (new), a default-exported Fastify plugin registered inside the
   authenticated scope in `src/index.ts` (next to the other `api.register` calls). Use
   `PROVIDERS` keys as an `enum` in every schema. Endpoints:
   - `GET /api/keys` → `{ file: keysFilePath(), defaultProvider: string | null, providers: [{ id, label, hasKey, source: KeySource | null, masked: string | null, defaultModel: string | null, isDefault: boolean, envName: string }] }`.
     `envName` is the provider's first `hostEnv` name; `defaultModel` is `effectiveModel(id) ?? null`;
     `defaultProvider` / `isDefault` come from `resolveProvider()` (only when it is a known
     provider with a key).
   - `POST /api/keys` body `{ provider, key }` (`key`: string, 8–400 chars, `additionalProperties: false`):
     reject with 409 `{ error: "<ENV_NAME> is set in the server's environment; change it there" }`
     when the current source is `"environment"`. Run `testKey`; on `refused` return 400
     `{ error: detail }` and save nothing; otherwise `setKeysFileValue(envName, key)` and return
     `{ provider, status, detail, masked }`.
   - `POST /api/keys/:provider/test` → tests the current key (any source) and returns
     `{ provider, status, detail }`; 404 `{ error: "No key for <label>" }` when there is none.
   - `DELETE /api/keys/:provider` → 409 when the source is `"environment"` (same message), 404 when
     there's no saved key; otherwise remove every `hostEnv` name of that provider from the keys
     file, and if `DEFAULT_PROVIDER` in the keys file names this provider remove that line too.
     Returns `{ provider, removed: true }`.
   - `PUT /api/keys/default` body `{ provider }` → 400 when that provider has no key; otherwise
     `setKeysFileValue("DEFAULT_PROVIDER", provider)` and return `{ defaultProvider: provider }`.
     If `shellEnv.DEFAULT_PROVIDER` is set, return 409 (it would win anyway).
   - Never log or return a full key.

5. `src/cli.ts`: add `hive keys` with subcommands, and add them to `USAGE` and the command table
   used by `--help`:
   - `hive keys` / `hive keys list`: one line per provider: label, masked key or `no key`, source
     (`saved`, `environment`, `.env`), default model, and `(default)` on the default provider.
   - `hive keys add <provider> [--no-test]`: reads the key from stdin when stdin is not a TTY,
     otherwise prompts `Paste the <label> API key: ` with echo off (use `readline` with
     `output` muted, or `process.stdin.setRawMode`). Tests it unless `--no-test` (refused → exit 1,
     nothing saved; unchecked → save and print the warning), then saves to the keys file and prints
     `Saved the <label> key to <file>`.
   - `hive keys test [provider]`: tests one provider's key, or every provider that has one; prints
     the status and detail; exit 1 if any was refused.
   - `hive keys remove <provider>`: removes the saved key (refuses with a clear message when it
     comes from the environment).
   - `hive keys default <provider>`: sets `DEFAULT_PROVIDER` in the keys file (provider must have a
     key).

6. `ui/src/main.ts` and `ui/src/app.css`: rebuild **Settings › API keys** after the design mockup
   (screen 2), in the existing style (cards, pills, `.btn`, light and dark tokens). Fetch
   `GET /api/keys` when the page opens.
   - Heading "API keys", the existing lead sentence, and an **Add key** button (`#addKeyBtn`) on the
     right of the heading row; hidden when every provider has a key.
   - Add form (`#addKeyForm`), shown under the heading: provider chips (radio buttons, only providers
     without a key), a password input `#newKey` labelled "<Label> API key", **Cancel**, and
     **Test and save** (`#saveKeyBtn`, disabled until the key is at least 8 characters). Under it:
     "Saved to <file>, readable only by you. hive makes one free request to check the key first."
     On a 400/409 show the error inline and keep the form open; on success close it, reload the
     table, and show the returned status on that row.
   - Table `#keysTable` with columns **Provider**, **Key and default model** (masked key in
     monospace, then "Default model: <model>" or "No default model (set one per run)"),
     **Status** (pill: `Not tested` muted, `Testing…`, `Works` ok, `Refused` danger, `Unchecked` warn,
     with the detail as the pill's `title`), **Default** (an accent `Default` pill on the default
     provider; otherwise a **Make default** text button, only on providers with a key), and
     **Actions**: **Test** and **Remove**. Providers without a key show `No key` and no actions.
   - Keys whose source is `environment` show "From the environment (<ENV_NAME>)" under the masked
     key; their **Remove** button is disabled with the title "Set in the server's environment;
     change it there".
   - **Remove** shows an inline confirmation row: "Remove the <Label> key? Runs that use <Label>
     will stop working until you add one again." with **Keep it** and **Remove key**.
   - Under the table, a card "Where keys are kept": "Saved keys live in <file>, readable only by
     you. An exported variable such as OPENROUTER_API_KEY wins over a saved key." and a dark code
     block with `hive keys list`, `hive keys add deepseek`, `hive keys test`,
     `hive keys default openrouter`, `hive keys remove openai`.
   - After any change (add, remove, make default) also refresh the module's `providers` data
     (`/api/providers`) so the New run form's provider list and defaults update without a reload.
   - Render every value with `el()` / `textContent`; never put the key the user typed anywhere but
     the request body; clear `#newKey` after saving or cancelling.

7. `ui/vite.config.ts`: no change needed (`/api` is already proxied).

8. `scripts/ui-smoke.mjs`: keep every existing check. Start the smoke server with an extra env
   `HIVE_KEYS_FILE` pointing at a file in a temp dir (and keep `DEEPSEEK_API_KEY` /
   `OPENROUTER_API_KEY` in its environment as today). In the Settings section, after the existing
   API keys checks (update those selectors to `#keysTable` if the id changes):
   - assert the DeepSeek row says "From the environment (DEEPSEEK_API_KEY)" and its Remove button is
     disabled;
   - mock `POST /api/keys` with `page.route` to answer
     `{ provider: "zai", status: "works", detail: "The provider accepted the key", masked: "…a1" }`
     (so no real network call); click `#addKeyBtn`, pick Z.AI, type `test-key-123456`, click
     `#saveKeyBtn`; assert the request body was `{ provider: "zai", key: "test-key-123456" }` and
     the form closed; unroute;
   - save `.handoff/ui-keys.png`.

9. `test/keys.test.mjs` (new), `node:test` style, with `HIVE_KEYS_FILE` and `HIVE_DOTENV_PATH`
   pointing into a `mkdtempSync` dir before importing from `dist/`:
   - `setKeysFileValue` writes `A=1`, then `B=2`, keeps a comment line and `A`, removes `A` with
     `null`; the file mode is `0o600`; values with a newline, a space, a quote or `#` throw.
   - `readKeysFile` picks up a change made after a first read.
   - `maskKey("sk-or-v1-abcdefghijklmnop1234")` keeps the last 4 and hides the middle; no mask
     equals its input.
   - `keySource` prefers shellEnv over the file over processEnv, and reports the source.
   - `testKey` with a fake `fetchImpl`: deepseek 200 → works (and the URL and Authorization header
     are as specified); openrouter 401 → refused; anthropic sends `x-api-key` and
     `anthropic-version`; a 500 → unchecked; a rejected fetch → unchecked.
   - `hive keys add zai --no-test` with the key on stdin (`spawnSync(process.execPath, ["dist/cli.js", "keys", "add", "zai", "--no-test"], { input: "zk-test-1234567890\n", env: { ...process.env, HIVE_KEYS_FILE: file } })`)
     exits 0 and writes `ZAI_API_KEY=zk-test-1234567890` to the file; `hive keys list` then shows
     a masked Z.AI key that does not contain `zk-test-1234567890`.

10. `README.md`: in Settings and the web UI section, describe key management (Settings › API keys
    and `hive keys`), the keys file and its precedence (environment > keys file > server `.env`),
    and that the server reads the keys file too. Add `hive keys` to the CLI command table and the
    new endpoints to the API table. `AGENTS.md`: layout rows for `src/keys.ts` and
    `src/routes/keys.ts`; a security invariant: keys are written only to the keys file (mode 600,
    atomic rename), never logged or returned whole, and values are validated so they can't inject
    other lines. Remove "key management" from "Not built yet". `docs/GUI.md`: Settings › API keys is
    built (Test, Make default, Remove, Add key; storage is the private file; no keychain).

## Acceptance

- `npm test` exits 0 and includes the tests from `test/keys.test.mjs` passing.
- `npm run build:ui` exits 0.
- `npm i --no-save playwright-core@1.49.1 && node scripts/ui-smoke.mjs` prints `ui-smoke: ok`
  and exits 0, and `.handoff/ui-keys.png` exists.
- `HIVE_KEYS_FILE=$(mktemp -d)/env node dist/cli.js keys list` exits 0 and prints one line per
  provider.
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
  tests; never call a real provider API from a test or script (tests use a fake `fetchImpl`, the
  smoke test mocks `/api/keys`); never write to the real `~/.config/agent-hive/env` (tests and the
  smoke server set `HIVE_KEYS_FILE`). If something outside Acceptance fails, note it in the report
  and finish.
- Every new route stays in the authenticated scope. No key is ever logged, put in an error
  message, or returned whole. No new dependencies; no emoji in the UI.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- The server's own login tokens, per-provider default models in Settings, the system keychain,
  the first-run onboarding screens, the run form itself (beyond refreshing provider data).

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
