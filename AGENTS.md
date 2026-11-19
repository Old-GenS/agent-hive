# Agent Hive — AGENTS.md

## What this is

A self-hosted coding agent server. A task clones a GitHub repo on the host, runs
[pi](https://pi.dev) on a copy of it inside a throwaway podman sandbox (a krun microVM when the
host has KVM), and pushes the agent's commits to a new `hive/<id>` branch. REST API, a web UI at
`/ui/`, and MCP via the separate [hive-mcp](https://github.com/stansz/hive-mcp) package.

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Fastify setup: public routes (landing, `/ui/`, `/health`) and the authenticated API scope |
| `src/config.ts` | All env-var config, provider table (`PROVIDERS`) |
| `src/auth.ts` | Bearer tokens (`API_TOKEN` / `API_TOKENS`), one-time WebSocket tickets |
| `src/tasks.ts` | Task lifecycle: queue → clone → agent run → review cycles → export → push; idle cleanup |
| `src/sandbox.ts` | `podman run` / `pasta` + `hive-vm` wrapper, runtime detection (libkrun / krun / runsc / plain container), JSONL parsing |
| `src/git.ts` | Host-side git on the pristine clone only: clone, `git am` the patches, push |
| `src/cli.ts` | `hive` CLI: argument parsing and command dispatch (run/log/diff/apply/list/clean) |
| `src/runs.ts` | CLI run dirs and `meta.json`, VM launch via `runSandbox`, export, diff, apply |
| `src/follow.ts` | Polls a JSONL file by byte offset (the VM's `io/events.jsonl`) |
| `src/render.ts` | Plain-text rendering of pi events plus token/cost totals |
| `src/routes/sessions.ts` | `/prompt`, `/snippet`, `/status`, `/messages`, `/abort`, `/session`, `/files`, `/events` |
| `src/routes/github.ts` | `gh`-backed repo list, search, fork for the UI |
| `image/` | The sandbox image: pi (pinned `PI_VERSION`), `hive-agent` (runs pi), `hive-export` (format-patch), `hive-vm-init` (libkrun guest init) |
| `vm/` | libkrun backend: `hive-vm.c` (launcher), `build.sh`, `build-rootfs.sh` |
| `ui/` | Vite + vanilla TS web UI, built to `ui/dist` |
| `public/landing.html` | Landing page served at `/` |

Build: `npm run build` (server), `npm run build:ui`, `npm run build:image`; for the libkrun
backend also `npm run build:vm` and `npm run build:rootfs`. Run the tests with `npm test`.

## Security model — keep these invariants

1. **The sandbox gets nothing secret except one LLM key.** Mounts are only the task's `work/` and
   `session/` (plus `out/` for export). Keys are passed with `-e NAME` from the child env, never
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

## GitHub access (server)

The `hive` CLI needs none of this: it uses the user's own git credentials and `gh` login on the host; nothing is passed into the VM.

| Account | Role | Auth | Scope |
|---------|------|------|-------|
| **<owner>** | Repo owner | SSH deploy keys (per repo, write access) | Only repos with a key installed |
| **<bot>** | Hive's bot account | `gh` CLI login | Repo list/search, forks |

If the server is compromised, the attacker gets the bot account and the per-repo deploy keys, not
full access to the owner's GitHub. The sandbox gets neither.

- **Your repos:** task with `repo=<owner>/<repo>` → host clones via the deploy key → agent works in
  the sandbox → host pushes `hive/<id>` via the deploy key. Merge or open a PR yourself.
- **External repos:** fork into <bot> (UI "Fork" button or `POST /api/github/fork`), then run
  the task on `<bot>/<repo>`. PR creation is not built yet.

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

**Done:** sandboxed runs (libkrun/podman krun/runsc/container), branch push, review cycles with an
optional second model, follow-ups in the same session, WebSocket streaming with replay, snippet
endpoint, web UI, a shared npm cache and per-task token/cost totals.

**Not built yet:** PR creation, persistence across restarts (sessions are in memory; task dirs
are swept at startup), a comprehensive test suite (only the launcher CLI and sandbox command
building are covered), a per-task network allowlist for the sandbox.
