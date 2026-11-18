# Agent Hive

**Self-hosted coding agent server.** Send a task and a repo; get a branch back. Every task runs
[pi](https://pi.dev) in its own throwaway microVM, so a confused or prompt-injected agent can't
reach your server's keys.

```
POST /prompt {repo, prompt}
  host: clone repo with your deploy key      → origin/   (never mounted in a sandbox)
  host: copy it, no remote                   → work/
  VM:   pi works in /work and commits          (sees work/ and one LLM key, nothing else)
  VM:   optional review cycles                 (a second agent reviews the diff and fixes)
  VM:   git format-patch                     → out/
  host: git am onto origin/, push            → hive/<id>
```

The host never runs git inside the agent's copy, so hooks or config the agent writes into
`.git` can't execute on the server. Results always go to a new `hive/<id>` branch; you merge.

---

## Requirements

- Linux with **Node.js 20+**, **git**, and **rootless podman**
- For microVM isolation: `/dev/kvm` and **krun** (crun built with libkrun — `crun-krun` on
  Fedora; check your distro). Without them, tasks run as rootless containers — see
  [Isolation levels](#isolation-levels).
- An API key for at least one provider: DeepSeek, Z.AI, OpenRouter, Anthropic or OpenAI
- For private repos: an SSH deploy key per repo (see [AGENTS.md](AGENTS.md#adding-a-repo));
  for the UI's repo browser and forks: `gh auth login`

## Quick start

```bash
curl -sL https://raw.githubusercontent.com/stansz/agent-hive/main/install.sh | bash
cd ~/agent-hive
nano .env                 # API_TOKEN (openssl rand -hex 32) and one provider key
node dist/index.js
```

The installer builds the server, the web UI and the sandbox image. At startup the log says which
isolation it picked:

```
sandbox isolation: microvm (--runtime krun)
```

Building from source instead of using the installer: `npm ci && npm run build && npm run build:ui
&& npm run build:image`. To enable the libkrun backend, also run `npm run build:vm` and
`npm run build:rootfs` (needs `/dev/kvm`, libkrun and `pasta`). `npm test` runs the server build
and the test suite.

| URL | What |
|-----|------|
| `http://localhost:8080/` | Landing page |
| `http://localhost:8080/ui/` | Web UI: chat, pick a repo, watch the agent work |

The server listens on `127.0.0.1` by default. Put it behind a tunnel or reverse proxy with TLS
(e.g. Cloudflare Tunnel) rather than exposing the port; set `HOST=0.0.0.0` only if you must.

### MCP

```bash
export HIVE_URL=http://localhost:8080 HIVE_TOKEN=your-api-token
npx github:stansz/hive-mcp
```

See [stansz/hive-mcp](https://github.com/stansz/hive-mcp).

## Isolation levels

| Runtime | When | Boundary |
|---------|------|----------|
| `libkrun` | `/dev/kvm` usable, libkrun and `pasta` installed, `vm/hive-vm` and the rootfs present (auto) | Own guest kernel; no podman at run time. Read-only shared root with an in-RAM writable layer; a network namespace that blocks the host's loopback, gateway and own addresses. |
| `krun` | `/dev/kvm` usable and `krun` installed (auto) | Own guest kernel. Escaping needs a KVM/libkrun bug. |
| `runsc` | `HIVE_RUNTIME=runsc` with gVisor installed | User-space kernel; works without KVM. Not tested here. |
| default (`crun`/`runc`) | Fallback | Shared host kernel: namespaces + seccomp. A kernel exploit escapes to the user running podman. |

In every mode the sandbox has network access (it must reach the LLM API) and sees the selected
provider's key. In container mode, run agent-hive as a **dedicated user** that holds nothing but
what Hive needs, so an escape lands somewhere boring.

The libkrun backend boots a rootfs exported from the sandbox image. After rebuilding the image
(`npm run build:image`) you must re-run `npm run build:rootfs`.

## API

All endpoints except `/health` need `Authorization: Bearer <token>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/prompt` | Start a task, or follow up with `sessionId` |
| POST | `/snippet` | One-shot question about some code; waits and returns `{result}` |
| GET | `/status/:id` | Status, `resultBranch`, `commitsPushed`, `error` |
| GET | `/messages/:id` | Conversation so far |
| POST | `/abort/:id` | Stop the running sandbox |
| DELETE | `/session/:id` | Delete the session and its files |
| GET | `/files/:id?path=`, `/file/:id?path=` | Browse the agent's working copy |
| POST | `/events/:id/ticket` | One-time ticket (60 s) for the event stream |
| WS | `/events/:id?ticket=…` | pi's JSON events plus `hive_status` / `hive_done` |
| GET | `/capacity` | Running / queued sandboxes |
| GET | `/api/github/repos`, `/api/github/search?q=` | Repo list / search (via `gh`) |
| POST | `/api/github/fork` | Fork into the `gh` account; returns `{repo}` |
| GET | `/health` | Health check (no auth) |

### Start a task

```bash
curl -X POST http://localhost:8080/prompt \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "Fix the off-by-one in the pager", "repo": "owner/repo", "reviewCycles": 1}'
# → {"sessionId": "1a2b3c4d-…", "status": "queued", ...}

curl http://localhost:8080/status/1a2b3c4d-… -H "Authorization: Bearer $API_TOKEN"
# → {"status": "idle", "resultBranch": "hive/1a2b3c4d", "commitsPushed": 2, ...}
```

| Field | Description |
|-------|-------------|
| `prompt` | Required. The task. |
| `repo` | `owner/name` or a github.com URL. Omit for a repo-less chat. |
| `branch` | Branch to start from (default: the repo's default branch). |
| `provider` | `deepseek`, `zai`, `openrouter`, `anthropic`, `openai` (default: `DEFAULT_PROVIDER`, else the first with a key). |
| `model` | Model ID (default: `DEFAULT_MODEL`, else a per-provider default). |
| `thinkingLevel` | `off` … `xhigh` (default `DEFAULT_THINKING`). |
| `reviewCycles` | 0–5 review-and-fix passes before pushing. |
| `reviewModel` | A different model for the review passes. |
| `systemPromptOverride` | Replaces the appended system prompt. |
| `sessionId` | Follow up on an existing session: same pi conversation, same working copy; the branch is re-pushed. |

The event stream carries pi's [JSON events](https://pi.dev) (`message_update` text deltas,
`tool_execution_start`/`_end`, …) plus `hive_status` (`queued`, `cloning`, `running`,
`reviewing`, `pushing`, `idle`, `failed`, `aborted`) and a final `hive_done`. Events of the
current run are replayed to late subscribers.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `API_TOKEN` | — | Bearer token (min 16 chars). Or `API_TOKENS` as JSON `{"token": {"name": "…"}}`. |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Listen address |
| `DEFAULT_PROVIDER`, `DEFAULT_MODEL`, `DEFAULT_THINKING` | auto / per provider / `low` | Defaults for tasks |
| `DEEPSEEK_API_KEY`, `ZAI_API_KEY` (or `ZAI_CODE`), `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | | Provider keys; only the task's provider key enters its sandbox |
| `MAX_CONCURRENT_SESSIONS` | `2` | Sandboxes running at once; more tasks queue |
| `MAX_QUEUED_SESSIONS` | `10` | Queue length before `503` |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Idle sessions (and their files) are deleted after this |
| `HIVE_RUNTIME` | `auto` | `auto`, `libkrun`, `krun`, `runsc`, `crun`, `runc` |
| `HIVE_VM_BIN` | `vm/hive-vm` | libkrun launcher binary |
| `HIVE_ROOTFS` | `~/.local/share/agent-hive/rootfs/current` | Sandbox rootfs exported by `npm run build:rootfs`; re-run it after `npm run build:image` |
| `HIVE_LIBKRUN` | `libkrun.so.1` | libkrun shared library loaded by `hive-vm` at run time |
| `HIVE_NPM_CACHE` | `~/.cache/agent-hive/npm` | npm cache directory shared into sandboxes; empty disables |
| `HIVE_SANDBOX_MEMORY` / `HIVE_SANDBOX_CPUS` | `1g` / `1` | Per sandbox. Size `MAX_CONCURRENT_SESSIONS` × memory to fit the host. |
| `HIVE_SANDBOX_TIMEOUT_MIN` | `60` | A sandbox run is killed after this |
| `HIVE_IMAGE` | `localhost/agent-hive-sandbox:latest` | Sandbox image |
| `WORKSPACE` | `/tmp/hive-workspace` | Task directories |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `agent-hive` | Identity for the agent's commits |
| `HIVE_BRANCH_PREFIX` | `hive/` | Result branch prefix |
| `HIVE_SYSTEM_PROMPT` | built in | Appended to pi's system prompt |

## Running as a service

```ini
# ~/.config/systemd/user/agent-hive.service   (rootless podman wants a user service)
[Unit]
Description=Agent Hive
After=network-online.target

[Service]
WorkingDirectory=%h/agent-hive
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now agent-hive
sudo loginctl enable-linger $USER   # keep it running when you're logged out
```

## Upgrading pi

The sandbox image pins pi (`PI_VERSION` in `image/Containerfile`). To move to a newer release,
bump it and run `npm run build:image`, then `npm run build:rootfs` if you use the libkrun backend.
Running tasks keep the image they started with.

## License

Powered by [pi](https://pi.dev) (BSD 3-Clause).
