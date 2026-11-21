# Configuration

Everything is optional. Put settings in `~/.config/agent-hive/env` (one `NAME=value` per line), or
export them in your shell. `hive keys` and the web UI save provider keys and `DEFAULT_PROVIDER` in
that same file, readable only by you (mode 600).

Precedence: an exported environment variable beats the keys file, which beats a `.env` file in the
folder hive is started from (handy when running the server from a source checkout).

## Keys and models

| Variable | Default | Meaning |
|----------|---------|---------|
| `DEEPSEEK_API_KEY`, `ZAI_API_KEY` (or `ZAI_CODE`), `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | — | Provider keys. Only the chosen provider's key enters the VM. |
| `DEFAULT_PROVIDER` | the first provider with a key | Used when `-p` is omitted |
| `DEFAULT_MODEL` | the provider's default | Used when `-m` is omitted |
| `DEFAULT_THINKING` | `low` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `HIVE_SYSTEM_PROMPT` | built in | Appended to pi's system prompt |
| `HIVE_OPENROUTER_ROUTING` | `{"quantizations":["fp16","bf16","fp8"]}` | OpenRouter provider routing, as JSON (below) |

### Provider and model

The provider is `-p` if given, else `DEFAULT_PROVIDER`, else the first of these that has a key:
DeepSeek, Z.AI, OpenRouter, Anthropic, OpenAI. The model is `-m` if given, else `DEFAULT_MODEL`,
else the provider's default:

| Provider | Default model |
|----------|---------------|
| DeepSeek | `deepseek-flash` |
| Z.AI | `glm-5.3` |
| OpenRouter | `xiaomi/mimo-v2.6-flash` |
| Anthropic | none: `-m` or `DEFAULT_MODEL` is required |
| OpenAI | none: `-m` or `DEFAULT_MODEL` is required |

`DEFAULT_MODEL` applies to whichever provider is picked, so set it together with
`DEFAULT_PROVIDER`. `hive doctor` prints what will be used, and the web UI shows the same under
Settings › API keys.

### OpenRouter routing

pi's built-in OpenRouter list lags behind new models, so for each OpenRouter run hive looks the
model up on OpenRouter and writes pi's `models.json` itself (context window, prices, image input,
reasoning), so cost totals are right.

OpenRouter also moves a model between upstream providers mid-run, and every move re-sends the whole
conversation without the prompt cache. So hive ranks the model's providers once, before the run,
and sends a fixed order: the model maker's own endpoint first, then higher uptime, then lower
price, keeping only endpoints that are up, support tools and have cache pricing. Later providers
are used only if the first one fails. `hive run` prints the order it chose.

`HIVE_OPENROUTER_ROUTING` sets the base routing, sent as OpenRouter's
[`provider`](https://openrouter.ai/docs/guides/routing/provider-selection) field. The default
skips fp4/int4 endpoints, which are cheaper but worse at long agent runs; if a model has no
endpoint that qualifies, hive allows any for that run and says so. A routing that names providers
itself (`order` or `only`) is used as written; `{}` lets OpenRouter choose freely.

## Runs and the VM

| Variable | Default | Meaning |
|----------|---------|---------|
| `HIVE_SANDBOX_MEMORY` / `HIVE_SANDBOX_CPUS` | `2048m` / `1` | VM size. The VM's writable space lives in RAM, up to half of the memory. |
| `HIVE_SANDBOX_TIMEOUT_MIN` | `60` | Each agent step is stopped after this many minutes |
| `HIVE_STALL_MIN` | `15` | Stop a run when no file changed and no event arrived for this many minutes; `0` turns it off |
| `HIVE_VM_CACHE` | `~/.cache/agent-hive/vm-cache` | Each repo gets its own bucket of `~/.cache` inside the VM (npm, pip, Playwright, corepack), shared by that repo's runs only; empty disables it. It must never hold anything secret. |
| `HIVE_VM_CACHE_DAYS` | `30` | Per-repo VM cache buckets not used for this many days are deleted; `0` keeps them |
| `HIVE_RUN_DISK_MAX_GB` | `20` | Stop an agent step when the run folder plus its cache bucket uses more than this many GB; `0` turns it off |
| `HIVE_MIN_FREE_DISK_GB` | `2` | Stop an agent step when less than this many GB are free on the disk holding the runs; `0` turns it off |
| `HIVE_RUNS_DIR` | `~/.cache/agent-hive/runs` | Where run folders live |
| `HIVE_RUN_RETENTION_DAYS` | `14` | Finished runs older than this are deleted; `0` keeps them forever |
| `HIVE_ROOTFS` | `~/.local/share/agent-hive/rootfs/current` | The VM filesystem |
| `HIVE_LIBKRUN` | system `libkrun.so.1` if it works, else the bundled one | The libkrun library the launcher loads. Setting it forces that library (`libkrun from HIVE_LIBKRUN` in doctor) and disables the fallback scan. |
| `HIVE_NETWORK` | `proxy` | `proxy`: the VM's only way out is hive's egress proxy, which allows public internet addresses only (not this computer or the local network). `direct`: pasta's own network (internet and local network, still not this computer). |

`HIVE_SANDBOX_MEMORY`, `HIVE_SANDBOX_CPUS`, `HIVE_SANDBOX_TIMEOUT_MIN`, `HIVE_STALL_MIN`,
`HIVE_RUN_DISK_MAX_GB` and `MAX_CONCURRENT_SESSIONS` can also be changed in the web UI under
**Settings › Runs**, which writes the same keys file (`HIVE_KEYS_FILE`) and applies to new runs
without a restart; the CLI reads the file when it starts. A value set in the server's environment
wins over the file and is shown read-only there.

A VM only uses the memory it actually touches, but several heavy runs at once can still run a
small machine out of memory: keep `MAX_CONCURRENT_SESSIONS` × `HIVE_SANDBOX_MEMORY` well under
your RAM.

The disk limits are checked every 15 s (free space) and every minute (size), so a run can briefly
overshoot.

## Git and GitHub

| Variable | Default | Meaning |
|----------|---------|---------|
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | your git `user.name` / `user.email` | Identity for the agent's commits |
| `HIVE_BRANCH_PREFIX` | `hive/` | Prefix for pushed branches |
| `HIVE_PUSH_REMOTE` | `origin` | Remote `hive push` uses for runs on a local checkout |
| `HIVE_GIT_PROTOCOL` | `https` | How the server clones and pushes `owner/name` repos: `https` uses your git credentials (e.g. `gh auth login`), `ssh` uses SSH keys (per-repo deploy keys) |

## Server

| Variable | Default | Meaning |
|----------|---------|---------|
| `API_TOKEN` | created by `hive serve` | Login token for the web UI and API (16+ characters). Or `API_TOKENS` as JSON `{"<token>": {"name": "…"}}` for several users. |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address |
| `MAX_CONCURRENT_SESSIONS` | `2` | Runs at once; more wait in a queue |
| `HIVE_RUNTIME` | `auto` | `auto` or `libkrun` |
| `HIVE_KEYS_FILE` | `~/.config/agent-hive/env` | The private keys and settings file |

## Updates

| Variable | Default | Meaning |
|----------|---------|---------|
| `HIVE_NO_UPDATE_CHECK` | — | `1` stops the once-a-day "new version available" notice |
| `HIVE_RELEASE_REPO` | `ogsapps/agent-hive` | Where releases are looked up |
| `GH_TOKEN` / `GITHUB_TOKEN` | — | Used for release lookups when set |
