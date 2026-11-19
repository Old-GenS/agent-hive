## Goal

Make the default provider, model and thinking level visible and choosable:

- A new authenticated endpoint `GET /api/providers` reports the resolved defaults and which
  providers have a key (never key values).
- The web UI (`ui/src/main.ts`) shows the resolved defaults in its provider, model and thinking
  controls, lets the user pick only providers that have a key, and says which provider and model a
  new session uses.
- `hive doctor` prints the default provider, model and thinking level.
- README and AGENTS.md document how the defaults are chosen.

## Files to touch

- `src/config.ts`
- `src/runs.ts`
- `src/tasks.ts`
- `src/routes/providers.ts` (new)
- `src/index.ts`
- `src/cli.ts`
- `ui/src/main.ts`
- `test/providers.test.mjs` (new)
- `README.md`
- `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`.

2. `src/config.ts`:
   - Add a `label: string` field to every `PROVIDERS` entry and to its type: deepseek `"DeepSeek"`,
     zai `"Z.AI"`, openrouter `"OpenRouter"`, anthropic `"Anthropic"`, openai `"OpenAI"`. Keep the
     entries in their current order; the order is the fallback order.
   - Add and export `effectiveModel(provider: string): string | undefined`, returning
     `config.defaultModel || PROVIDERS[provider]?.defaultModel || undefined`. Define it after
     `config`.
   - Add and export this type and function, after `effectiveModel`:

     ```ts
     export interface ProviderInfo {
       default: {
         provider: string | null;
         providerSource: "DEFAULT_PROVIDER" | "first provider with a key" | null;
         model: string | null;
         modelSource: "DEFAULT_MODEL" | "provider default" | null;
         thinking: string;
       };
       providers: { id: string; label: string; hasKey: boolean; model: string | null }[];
     }
     export function providerInfo(): ProviderInfo
     ```

     - `default.provider` is `resolveProvider()` when it names a key in `PROVIDERS`, else `null`.
     - `providerSource` is `"DEFAULT_PROVIDER"` when `process.env.DEFAULT_PROVIDER` is set and
       valid, `"first provider with a key"` when the provider came from the fallback, `null` when
       `provider` is `null`.
     - `default.model` is `effectiveModel(provider)` or `null`; `modelSource` is
       `"DEFAULT_MODEL"` when `config.defaultModel` is non-empty, `"provider default"` when the
       model came from the provider entry, `null` when `model` is `null`.
     - `default.thinking` is `config.defaultThinking`.
     - `providers` lists every `PROVIDERS` entry in order: `hasKey` is `!!providerKey(id)`,
       `model` is `effectiveModel(id) ?? null`.
     - The returned object must never contain a key value.

3. `src/runs.ts` (`startRun`) and `src/tasks.ts` (`createTask`): replace
   `o.model || config.defaultModel || PROVIDERS[provider].defaultModel` (runs.ts) and
   `opts.model || config.defaultModel || PROVIDERS[provider].defaultModel` (tasks.ts) with
   `o.model || effectiveModel(provider)` / `opts.model || effectiveModel(provider)`, importing
   `effectiveModel` from `./config.js`. No other behavior change.

4. `src/routes/providers.ts` (new): a default-exported async Fastify plugin
   `(app: FastifyInstance) => { app.get("/api/providers", async () => providerInfo()); }`, in the
   style of `src/routes/github.ts`. In `src/index.ts`, import it and register it inside the
   authenticated scope, next to `await api.register(githubRoutes);`.

5. `src/cli.ts`, `cmdDoctor`: import `providerInfo` with the existing dynamic
   `import("./config.js")`. Before the final `process.stdout.write`, push these lines. They do not
   change `allOk` or the exit code.
   - Provider:
     - provider set and source `DEFAULT_PROVIDER`: `provider: <id> (DEFAULT_PROVIDER)`
     - provider set by fallback: `provider: <id> (first provider with a key; set DEFAULT_PROVIDER to choose)`
     - `process.env.DEFAULT_PROVIDER` set but not a key of `PROVIDERS`:
       `provider: unknown "<value>" (DEFAULT_PROVIDER); supported: deepseek, zai, openrouter, anthropic, openai`
     - otherwise: `provider: none (no API key set)`
   - Model, only when `default.model` is non-null: `model: <model> (DEFAULT_MODEL)` or
     `model: <model> (<provider>'s default)`
   - Always: `thinking: <thinking>`

6. `ui/src/main.ts`:
   - Add `async function loadProviders()`, called at the end of `renderApp` (do not await it in a
     way that blocks rendering). It calls `api("/api/providers")`; if the response is not ok or
     throws, it leaves the existing static controls unchanged.
   - On success it rebuilds `#providerSelect`:
     - first option value `""`, text `Provider: default (<label> · <model>)` when
       `default.provider` is set, else `Provider: default (none: no API key)`;
     - then one option per entry of `providers`, value `id`, text `label`; entries with
       `hasKey: false` get the text `<label> (no key)` and are `disabled`.
   - It sets the first option of `#thinkingSelect` to text `Thinking: default (<thinking>)`.
   - It sets `#modelInput`'s placeholder to `model (<m>)`, where `<m>` is the selected provider's
     `model`, or `default.model` when the empty option is selected, or `model` when neither is
     known. Do this on load and on every `change` of `#providerSelect`.
   - Build options with `document.createElement("option")` and `textContent`; never put server
     data into `innerHTML` unescaped.
   - In `sendChat`, after a new session starts (inside the existing `if (!sessionId)` block that
     sets `sessionId`), add a system message using the `/prompt` response's `provider` and
     `model`: `addMessage("system", esc(\`🐝 ${data.provider} · ${data.model}\`))`.

7. `test/providers.test.mjs` (new), using `node:test` and `node:assert/strict` like the other
   tests. Before importing anything from `dist/`, set `process.env.HIVE_DOTENV_PATH` to a path that
   does not exist (inside a `mkdtempSync` dir), delete `DEFAULT_PROVIDER`, `DEFAULT_MODEL`,
   `DEFAULT_THINKING`, `ZAI_API_KEY`, `ZAI_CODE`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and set
   `DEEPSEEK_API_KEY=sk-test-deepseek-secret` and `OPENROUTER_API_KEY=sk-test-openrouter-secret`.
   Then `const { providerInfo } = await import("../dist/config.js");`. Tests:
   - "providerInfo falls back to the first provider with a key": `default` deep-equals
     `{ provider: "deepseek", providerSource: "first provider with a key", model: "deepseek-v4-pro", modelSource: "provider default", thinking: "low" }`;
     the `openrouter` entry has `hasKey: true` and `model: "xiaomi/mimo-v2.6-flash"`; the `zai`
     entry has `hasKey: false`.
   - "providerInfo honours DEFAULT_PROVIDER": set `process.env.DEFAULT_PROVIDER = "openrouter"`,
     call it, expect provider `openrouter`, source `DEFAULT_PROVIDER`, model
     `xiaomi/mimo-v2.6-flash`; delete `DEFAULT_PROVIDER` afterwards.
   - "providerInfo never includes key values": `JSON.stringify(providerInfo())` does not contain
     `secret`.
   - "hive doctor prints the default provider": `spawnSync(process.execPath, ["dist/cli.js", "doctor"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, DEFAULT_PROVIDER: "openrouter" } })`;
     stdout matches `/^provider: openrouter \(DEFAULT_PROVIDER\)$/m`, `/^model: xiaomi\/mimo-v2\.6-flash \(openrouter's default\)$/m`
     and `/^thinking: low$/m`. Do not assert the exit code (the VM may have no KVM).

8. `README.md`:
   - After the `### Settings` table, add a `### Provider and model` subsection stating:
     the provider is `-p` if given, else `DEFAULT_PROVIDER`, else the first provider in this order
     that has a key: DeepSeek, Z.AI, OpenRouter, Anthropic, OpenAI; the model is `-m` if given,
     else `DEFAULT_MODEL`, else the provider's default; a table of default models (DeepSeek
     `deepseek-v4-pro`, Z.AI `glm-5.3`, OpenRouter `xiaomi/mimo-v2.6-flash`, Anthropic and OpenAI:
     none, `-m` or `DEFAULT_MODEL` required); that `DEFAULT_MODEL` applies whichever provider is
     picked, so set it only together with `DEFAULT_PROVIDER`; that with both `DEEPSEEK_API_KEY` and
     `OPENROUTER_API_KEY` set, DeepSeek is used unless `DEFAULT_PROVIDER=openrouter`; that
     `hive doctor` prints what will be used; that the web UI shows the defaults and lists only
     providers with a key.
   - In the API table, add a row after `/capacity`:
     `| GET | \`/api/providers\` | Default provider, model and thinking level, and which providers have a key (never the keys) |`.

9. `AGENTS.md`: in the Layout table, add a row after `src/routes/github.ts`:
   `| \`src/routes/providers.ts\` | \`/api/providers\`: resolved defaults and which providers have a key, for the UI |`.

## Acceptance

- `npm test` exits 0, and its output includes the four tests from `test/providers.test.mjs`
  passing.
- `npm run build:ui` exits 0.
- `grep -rl "/api/providers" ui/dist/assets` prints at least one file.
- `env -u DEEPSEEK_API_KEY -u ZAI_API_KEY -u ZAI_CODE -u ANTHROPIC_API_KEY -u OPENAI_API_KEY DEFAULT_PROVIDER= OPENROUTER_API_KEY=x HIVE_DOTENV_PATH=/nonexistent node dist/cli.js doctor | grep -E '^(provider|model|thinking):'`
  prints exactly these three lines:
  `provider: openrouter (first provider with a key; set DEFAULT_PROVIDER to choose)`,
  `model: xiaomi/mimo-v2.6-flash (openrouter's default)`, `thinking: low`.
- `grep -c "DEFAULT_PROVIDER" README.md` prints a number of at least 3.
- `git diff --stat` lists no files other than those in **Files to touch** (plus
  `package-lock.json` only if `npm ci` changed it, which it should not).

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies (`npm ci`) and temporary files
  outside the repo are fine.
- The only checks to run are the **Acceptance** commands. Don't write or run extra end-to-end
  tests, don't start the server, and don't run a script against a server or service. If something
  outside Acceptance fails, note it in the report and finish.
- Do not change `PROVIDERS` order, default models, the `/prompt` API, or the security invariants
  in `AGENTS.md`. No new dependencies.
- In the UI, render all server data with `textContent` or `esc()`.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Storing keys or defaults from the UI, the GUI onboarding in `docs/GUI.md`, a model picker
  that lists models from providers, changes to `hive run` output, `landing.html`.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
