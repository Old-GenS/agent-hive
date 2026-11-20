# Agent Hive — AGENTS.md

## What this is

A tool that runs [pi](https://pi.dev) on a repo inside a throwaway microVM.

- **The main interface is the `hive` CLI** (`src/cli.ts`, `src/runs.ts`). It clones the current
  repo, or a remote with `--repo`, and boots a libkrun VM with `vm/hive-vm` under pasta. The
  prompt goes in as a file, the agent's events come out as a log file, and its commits come back
  as patches. You then apply them, or push a branch and open a PR.
- **The same core also runs as an optional HTTP server** (`src/index.ts`, `src/tasks.ts`) with a
  REST API, a web UI at `/ui/`, and MCP via the separate
  [hive-mcp](https://github.com/stansz/hive-mcp) package.

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Fastify setup: public routes (landing, `/ui/`, `/health`) and the authenticated API scope |
| `src/config.ts` | All env-var config, provider table (`PROVIDERS`) |
| `src/auth.ts` | Bearer tokens (`API_TOKEN` / `API_TOKENS`), one-time WebSocket tickets |
| `src/tasks.ts` | Task lifecycle: queue → clone (or a new empty repo) → agent run → review cycles → export → push (or create the GitHub repo); change summary; pull requests on request; idle cleanup |
| `src/sandbox.ts` | `podman run` / `pasta` + `hive-vm` wrapper, runtime detection (libkrun / krun / runsc / plain container), JSONL parsing; under libkrun the VM writes its events to a mounted `io/` folder that the host follows; `systemInfo()` for the UI |
| `src/git.ts` | Host-side git on the pristine clone only: clone, new-repo setup, `git am` the patches, push, change summary; `gh` helpers for the login, `gh repo create` and `gh pr create` |
| `src/cli.ts` | `hive` CLI: argument parsing and command dispatch (run/log/diff/apply/push/list/clean); sets the commit identity from the user's git config |
| `src/runs.ts` | CLI run dirs and `meta.json`, VM launch via `runSandbox`, export, diff, apply, push (never forced) and `gh pr create` |
| `src/follow.ts` | Polls a JSONL file by byte offset (the VM's `io/events.jsonl`); opens it with `O_NOFOLLOW` |
| `src/render.ts` | Plain-text rendering of pi events plus token/cost totals |
| `src/routes/sessions.ts` | `/prompt`, `/snippet`, `/status`, `/messages`, `/pr`, `/abort`, `/session`, `/files`, `/events` |
| `src/routes/github.ts` | `gh`-backed repo list, branches, search, fork for the UI |
| `src/routes/providers.ts` | `/api/providers` and `/api/models` for the UI |
| `src/routes/system.ts` | `/api/system`: sandbox setup and checks for Settings › This computer |
| `src/models.ts` | Model lists per provider (OpenRouter's live list, cached 1 h) |
| `image/` | The sandbox image: pi (pinned `PI_VERSION`), `hive-agent` (runs pi), `hive-export` (format-patch), `hive-vm-init` (libkrun guest init) |
| `vm/` | libkrun backend: `hive-vm.c` (launcher), `build.sh`, `build-rootfs.sh` |
| `ui/` | Vite + vanilla TS web UI, built to `ui/dist`: `main.ts` (Runs: form, timeline, result; Settings: API keys, This computer), `bee.ts` (the run indicator), `util.ts` (`el()`, `esc()`, `api()`), `app.css` (light and dark tokens) |
| `scripts/` | `run-tests.mjs` (test runner with a throwaway `TMPDIR`), `ui-smoke.mjs` (headless browser check with a faked run), release build and signing |
| `public/landing.html` | Landing page served at `/` |

Build: `npm run build` (server), `npm run build:ui`, `npm run build:image`; for the libkrun
backend also `npm run build:vm` and `npm run build:rootfs`. Run the tests with `npm test`.

## Security model — keep these invariants

1. **The sandbox gets nothing secret except one LLM key.** Mounts are only the task's `work/`,
   `session/` and `io/` (plus `out/` for export). Keys are passed with `-e NAME` from the child env, never
   on the command line. Don't add host mounts or env vars casually. The libkrun backend also maps
   no guest ports to the host and runs in a pasta namespace that cannot reach the host's loopback,
   gateway or own addresses; its root is a read-only export of the image with an in-RAM overlay.
2. **The host never runs git in `work/`.** The agent controls `work/.git` (hooks, config,
   filters, fsmonitor). Host git runs only in `origin/`, which no sandbox mounts, with hooks
   disabled. Changes cross over only as patch files applied with `git am`.
3. **Every API route lives inside the authenticated scope** in `index.ts`. Don't add path-based
   auth exceptions.
4. **Anything from GitHub or the agent is untrusted in the UI** — render with `esc()` only.
5. Repo URLs are restricted to github.com (`normalizeRepo`); `HIVE_ALLOW_ANY_REPO_URL=1` is for
   local testing only.
6. **The npm cache is the one thing shared between tasks.** `HIVE_NPM_CACHE` (default
   `~/.cache/agent-hive/npm`) is mounted read-write at `/root/.npm` in every agent sandbox, so it
   must never hold credentials or task data; it only caches packages.
7. **The CLI's host git runs only in the user's repo** (rev-parse, status, clone source, apply/am
   of exported patches), never in a run's `work/`. Text crosses into and out of the VM only as
   files in `io/` and patches in `out/`.
8. **Files the VM writes are read without following symlinks.** The host reads `io/events.jsonl`
   and `io/stderr.log` with `O_NOFOLLOW`, so the agent can't point the host at its own files.
9. **Nothing reaches GitHub on the agent's say-so.** Branch pushes and new repos happen in the host
   after the run; pull requests only when the user asks (`POST /pr/:id`). `gh` and `git` run with
   argument arrays, never a shell.

## GitHub access (server)

The `hive` CLI needs none of this: it uses the user's own git credentials and `gh` login on the host; nothing is passed into the VM.

Two setups, picked with `HIVE_GIT_PROTOCOL`:

- **`https` (default), a single box:** the server's `gh` login does everything: clone, push
  `hive/<id>` branches, list repos and branches, open pull requests, create new repos. Settings ›
  This computer shows which account it is. If the server is compromised, that account is exposed.
- **`ssh`, a VPS fleet:** per-repo deploy keys for clone and push, and a separate bot account's `gh`
  login for the rest:

| Account | Role | Auth | Scope |
|---------|------|------|-------|
| **<owner>** | Repo owner | SSH deploy keys (per repo, write access) | Only repos with a key installed |
| **<bot>** | Hive's bot account | `gh` CLI login | Repo list/search, forks, pull requests, new repos |

In the `ssh` setup a compromised server exposes the bot account and the per-repo deploy keys, not
full access to the owner's GitHub. The sandbox gets neither in either setup.

- **Your repos:** task with `repo=<owner>/<repo>` → host clones → agent works in the sandbox →
  host pushes `hive/<id>`. Open a PR from the UI's **Open pull request** button
  (`POST /pr/:id`, via `gh pr create`), or merge yourself.
- **External repos:** fork into the `gh` account (`POST /api/github/fork`), then run the task on
  the fork.
- **New projects:** a task with `newRepo` starts from an empty repo; when the agent has commits,
  the host runs `gh repo create <login>/<name>` (private by default) and pushes to `main`. Needs a
  `gh` login that may create repos.

### Adding a repo

```bash
# on the server, as the user that runs agent-hive
ssh-keygen -t ed25519 -f ~/.ssh/<repo>_deploy -N ""
# from your machine (or repo Settings → Deploy keys → Allow write access)
gh repo deploy-key add - --repo <owner>/<repo> --title hive-$(date +%Y%m%d) --allow-write < <repo>_deploy.pub
# on the server: add  IdentityFile ~/.ssh/<repo>_deploy  to the Host github.com block in ~/.ssh/config
git ls-remote git@github.com:<owner>/<repo>.git   # test
```

### Commit author

Commits made in the sandbox use `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` from `.env` (default
`agent-hive`).

## Status

**Done, CLI:** `hive run` on a local repo or `--repo`, with live progress. Also `log`, `diff`,
`apply`, `push` (branch, never forced), `push --pr` (GitHub PR via `gh`), `list` and `clean`.
Settings come from env vars or `~/.config/agent-hive/env`, and nothing is tied to an account.
Tested on Linux with KVM: real runs in libkrun VMs, a push to a branch, and a PR opened on
GitHub.

**Done, server:** sandboxed runs (libkrun/podman krun/runsc/container) with live events from
libkrun VMs, HTTPS (default) or SSH git, branch push, new projects (`gh repo create`), a change
summary per run, pull requests on click, review cycles with an optional second model, follow-ups
in the same session, WebSocket streaming with replay, snippet endpoint, a shared npm cache and
per-task token/cost totals.

**Done, web UI:** the new design (light and dark): Runs (new-run form with repo and branch lists,
per-provider model lists, New project; the bee indicator, a timeline with step check-offs, the
result with commits, files, a diff link and Open pull request) and Settings (API keys, read-only;
This computer). Checked by `scripts/ui-smoke.mjs`.

**Not built yet:**
- web UI: posting a no-change review as a GitHub issue
- web UI: key management and the first-run onboarding from `docs/GUI.md` (needs `hive keys`)
- server: refusing to restart, or finishing runs first, while runs are in progress
- `hive mcp` (stdio MCP for handing work to hive from other agents)
- `hive serve` (the server on top of the CLI core)
- macOS: the launcher build for Apple silicon, and network isolation without pasta
- follow-up prompts and review cycles in the CLI
- server persistence across restarts
- a per-run network allowlist
