# Agent Hive

**Run a coding agent on your repo inside a throwaway microVM.** Give `hive` a task. The agent
([pi](https://pi.dev), with any model you choose) works on a copy of the repo in a VM that can't
reach the rest of your machine. Its commits come back as patches, which you can review, apply, or
push as a branch or pull request.

```
hive run "fix the off-by-one in the pager"
  host: clone the repo (no hardlinks, no remote)  → work/
  VM:   pi works in /work and commits               (sees work/, the prompt and one LLM key)
  host: follow the agent's event log live           ← io/events.jsonl
  VM:   git format-patch                            → out/
hive diff        # review
hive apply       # into your working tree
hive push --pr   # or as a branch + GitHub pull request
```

Text crosses into and out of the VM only as files: the prompt goes in as a file, the agent's
events come out as a log file, and the results come back as patches. The host never runs git
inside the agent's copy, so hooks or config the agent writes into `.git` can't run on your
machine.

---

## Requirements

- Linux with `/dev/kvm`, **libkrun**, **pasta** (from the `passt` package), **Node.js 20+** and
  **git**
- **podman**, once, to build the sandbox image that the VM's root filesystem is exported from
- A C compiler for the small VM launcher (if there isn't one, `npm run build:vm` builds it in a
  container)
- An API key for at least one provider: DeepSeek, Z.AI, OpenRouter, Anthropic or OpenAI

macOS support is planned. libkrun runs on Apple silicon, but the launcher's build and network
isolation still need porting.

## Install

### From a release

```bash
curl -fsSL https://raw.githubusercontent.com/ogsapps/agent-hive/main/install-cli.sh | sh
```

This needs `/dev/kvm`, and the system's libkrun and pasta for now (Fedora:
`sudo dnf install libkrun passt`).

### From source

```bash
git clone https://github.com/ogsapps/agent-hive.git && cd agent-hive
npm ci && npm run build && npm run build:image && npm run build:vm && npm run build:rootfs
npm link            # puts `hive` on your PATH
```

Put your key(s) in `~/.config/agent-hive/env`:

```
OPENROUTER_API_KEY=sk-or-...
```

## Usage

```bash
cd ~/code/some-repo
hive run "add input validation to the signup form"
hive diff --stat
hive apply                       # as uncommitted changes in your working tree
# or
hive push --pr                   # new branch hive/<run> + a GitHub pull request
```

Without `--repo`, `hive` works on the current repo's `HEAD`, so uncommitted changes aren't
included. With `--repo owner/name` (or any git URL), it clones the remote and you don't need a
checkout:

```bash
hive run --repo owner/name --ref main "update the README for the new flags"
hive push --pr --base main
```

| Command | What it does |
|---------|--------------|
| `hive run "<prompt>"` | Clone the repo into a new run, run the agent in a VM, show its progress live, export its commits. Options: `-m model`, `-p provider`, `-t thinking`, `--json`, `-f <prompt-file>`, `--repo <owner/name\|url>`, `--ref <branch>`. Ctrl+C stops the run. |
| `hive log [run]` | Replay a run's event log. It follows the log live while the run is going. `--json` prints raw events. |
| `hive diff [run]` | Show the run's changes. `--stat` gives a summary. |
| `hive apply [run]` | Apply the run's patches to the current repo as uncommitted changes (the repo must be clean and at the run's base), or use `--branch <name>` to put them on a new branch. Local runs only. |
| `hive push [run]` | Put the run's commits on a new branch and push it with your own git credentials. `--branch <name>` (default `hive/<run>`), `--remote <name>` (default `origin`), `--pr` to open a GitHub pull request, `--base <branch>` for the PR's base. Never forced. |
| `hive list` | List runs, newest first. |
| `hive clean <run>` | Delete a run. `--all` deletes every finished run. |
| `hive setup` | Download the VM filesystem (rootfs) the installed release needs. |
| `hive doctor` | Show what's available: `/dev/kvm`, libkrun, pasta, the launcher and the rootfs. |
| `hive update [--check \| --rollback]` | Verify and install the latest release (`--check` only reports), or go back to the previous version (`--rollback`). |

`[run]` defaults to the newest run.

`--repo` accepts `owner/name` (meaning github.com), an `https://` or `ssh://` URL, or
`git@host:owner/name.git`. Pushing works with any git host. `--pr` needs a github.com remote and
the [GitHub CLI](https://cli.github.com) (`gh auth login`).

`hive push` and `--pr` run on your machine as you, so they use your own SSH key, git credential
helper or `gh` login. None of these ever enter the VM. Commits use your git `user.name` and
`user.email` unless `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` are set.

### Settings

All optional. Put them in `~/.config/agent-hive/env` or export them.

| Variable | Default | Meaning |
|----------|---------|---------|
| `DEEPSEEK_API_KEY`, `ZAI_API_KEY` (or `ZAI_CODE`), `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | — | Provider keys; only the selected one enters the VM |
| `DEFAULT_PROVIDER` | first provider with a key | Provider used when `-p` is omitted |
| `DEFAULT_MODEL` | per-provider default | Model used when `-m` is omitted |
| `DEFAULT_THINKING` | `low` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | your git `user.name` / `user.email` | Commit identity |
| `HIVE_BRANCH_PREFIX` | `hive/` | Prefix for the branch `hive push` creates |
| `HIVE_PUSH_REMOTE` | `origin` | Remote `hive push` uses for local runs |
| `HIVE_RUNS_DIR` | `~/.cache/agent-hive/runs` | Where runs are kept |
| `HIVE_SANDBOX_MEMORY` / `HIVE_SANDBOX_CPUS` | `1g` / `1` | VM size |
| `HIVE_SANDBOX_TIMEOUT_MIN` | `60` | The run is stopped after this many minutes |
| `HIVE_NPM_CACHE` | `~/.cache/agent-hive/npm` | npm download cache shared between runs; empty disables it |
| `HIVE_SYSTEM_PROMPT` | built in | Appended to pi's system prompt |
| `HIVE_NO_UPDATE_CHECK` | — | Set to `1` to stop the once-a-day "new version available" notice |
| `HIVE_RELEASE_REPO` | `ogsapps/agent-hive` | GitHub repo releases are looked up in |
| `GH_TOKEN` / `GITHUB_TOKEN` | — | Used for release lookups when set |

### Provider and model

The provider is `-p` if given, else `DEFAULT_PROVIDER`, else the first provider in this order that
has a key: DeepSeek, Z.AI, OpenRouter, Anthropic, OpenAI. The model is `-m` if given, else
`DEFAULT_MODEL`, else the provider's default:

| Provider | Default model |
|----------|---------------|
| DeepSeek | `deepseek-v4-pro` |
| Z.AI | `glm-5.3` |
| OpenRouter | `xiaomi/mimo-v2.6-flash` |
| Anthropic | none — `-m` or `DEFAULT_MODEL` is required |
| OpenAI | none — `-m` or `DEFAULT_MODEL` is required |

`DEFAULT_MODEL` applies whichever provider is picked, so set it only together with
`DEFAULT_PROVIDER`. With both `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY` set, DeepSeek is used
unless `DEFAULT_PROVIDER=openrouter`. `hive doctor` prints what will be used. The web UI shows the
resolved defaults (Settings, API keys) and lists only providers that have a key.

### Run directories

```
~/.cache/agent-hive/runs/<repo>-<YYYYMMDD-HHMMSS>/
  work/      the agent's copy (mounted at /work)
  io/        prompt.md, system.md, events.jsonl, stderr.log (mounted at /io)
  session/   pi's session (mounted at /session)
  out/       exported patches
  origin/    clean clone used for pushing (remote runs, and local runs once pushed)
  meta.json  repo, base, model, status, commits, cost, the agent's summary, push/PR info
```

## Isolation

Each run boots its own microVM with `vm/hive-vm`, a small launcher that loads libkrun at run time:

- **Own guest kernel:** escaping needs a KVM or libkrun bug.
- **Read-only shared root filesystem** with an in-RAM writable layer, so nothing carries over from
  one run to the next.
- **Its own network namespace via pasta:** the internet and DNS work, so the agent can reach the
  LLM API and package registries, but the host's loopback, gateway and LAN addresses are blocked.
- **Mounts:** only the run's `work/`, `io/` and `session/`, plus the shared npm cache. The selected
  provider's key is passed in the VM's environment, never on a command line.

After changing the image (`npm run build:image`), re-run `npm run build:rootfs`. To move to a newer
pi release, bump `PI_VERSION` in `image/Containerfile` and rebuild both.

## Server (optional)

The same core can also run as an HTTP server with a web UI, REST API and MCP, for a VPS or for
using it from a phone. The server runs each task in a podman sandbox (a krun microVM with KVM, or
gVisor or a rootless container without it), or in the libkrun backend above. It clones from GitHub
with per-repo deploy keys and pushes results to `hive/<id>` branches. It also supports review
cycles and follow-up messages. A future `hive serve` will put the server on top of the CLI core.

```bash
npm ci && npm run build && npm run build:ui && npm run build:image
cp .env.example .env      # API_TOKEN (openssl rand -hex 32) and one provider key
node dist/index.js        # http://127.0.0.1:8080/ui/
```

The server listens on `127.0.0.1`. Put it behind a tunnel or a TLS reverse proxy rather than
exposing the port. Setting up deploy keys and accounts is covered in [AGENTS.md](AGENTS.md).

### Web UI

The UI at `/ui/` has two views. **Runs** is the new-run form — task, optional repository and
branch, provider, a model box with a per-provider list you can pick from or type into, thinking
level and review cycles — followed by a live timeline of the run with Stop, follow-up messages and
a result banner. **Settings › API keys** shows each provider's key status, its default model and
which provider is the default; it is read-only for now. `npm run build:ui` builds the UI into
`ui/dist`.

Pick **New project** instead of a repository to start from an empty repo: give the project a name
and, when the run finishes with commits, the host creates that repository under the logged-in
`gh` account (private by default) and pushes the agent's work to its `main` branch. If the agent
made no commits, no repository is created.

### API

All endpoints except `/health` need `Authorization: Bearer <token>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/prompt` | Start a task (`prompt`, `repo`, `branch`, `newRepo` (`{name, private}`), `provider`, `model`, `thinkingLevel`, `reviewCycles`, `reviewModel`), or follow up with `sessionId` |
| POST | `/snippet` | One-shot question about some code; waits and returns `{result}` |
| GET | `/status/:id` | Status, `resultBranch`, `commitsPushed`, `error` |
| GET | `/messages/:id` | Conversation so far |
| POST | `/abort/:id` | Stop the running sandbox |
| DELETE | `/session/:id` | Delete the session and its files |
| GET | `/files/:id?path=`, `/file/:id?path=` | Browse the agent's working copy |
| POST | `/events/:id/ticket` | One-time ticket (60 s) for the event stream |
| WS | `/events/:id?ticket=…` | pi's JSON events plus `hive_status` / `hive_done` |
| GET | `/capacity` | Running / queued sandboxes |
| GET | `/api/system` | Sandbox setup (microVM via libkrun, podman with krun or gVisor, or plain containers), its checks, VM size, capacity and git transport |
| GET | `/api/providers` | Default provider, model and thinking level, and which providers have a key (never the keys) |
| GET | `/api/models?provider=` | Models to offer for a provider (OpenRouter's live list, a fixed list for the others) |
| GET | `/api/github/repos`, `/api/github/search?q=` | Repo list / search (via `gh`) |
| GET | `/api/github/branches?repo=owner/name` | A repo's branches, default first (via `gh`) |
| POST | `/api/github/fork` | Fork into the `gh` account; returns `{repo}` |
| GET | `/health` | Health check (no auth) |

### Server configuration

In addition to the provider and sandbox settings above:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_TOKEN` | — | Bearer token (min 16 chars). Or `API_TOKENS` as JSON `{"token": {"name": "…"}}`. |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Listen address |
| `MAX_CONCURRENT_SESSIONS` / `MAX_QUEUED_SESSIONS` | `2` / `10` | Sandboxes at once / queue length before `503` |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Idle sessions and their files are deleted after this |
| `HIVE_RUNTIME` | `auto` | `auto`, `libkrun`, `krun`, `runsc`, `crun`, `runc` |
| `HIVE_IMAGE` | `localhost/agent-hive-sandbox:latest` | Sandbox image |
| `WORKSPACE` | `/tmp/hive-workspace` | Task directories |
| `HIVE_GIT_PROTOCOL` | `https` | How the server clones and pushes `owner/name` repos: `https` uses the host's git credentials (e.g. `gh auth login`), `ssh` uses the host's SSH keys (per-repo deploy keys, handy across several VPSes) |

## Development

`npm test` builds and runs the test suite. The code layout and the security rules the code relies
on are in [AGENTS.md](AGENTS.md).

## License

Powered by [pi](https://pi.dev) (BSD 3-Clause).
