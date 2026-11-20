# Agent Hive — AGENTS.md

## What this is

A tool that runs [pi](https://pi.dev) on a repo inside a throwaway microVM.

- **The main interface is the `hive` CLI** (`src/cli.ts`, `src/runs.ts`). It clones the current
  repo, or a remote with `--repo`, and boots a libkrun VM with `vm/hive-vm` under pasta. The
  prompt goes in as a file, the agent's events come out as a log file, and its commits come back
  as patches. You then apply them, or push a branch and open a PR.
- **The same engine also runs behind an optional HTTP server** (`hive serve`: `src/index.ts`,
  `src/web-runs.ts`) with a REST API and a web UI at `/ui/`. There is one run engine
  (`src/runs.ts`); web runs and `hive run` runs share one run list. The separate
  [hive-mcp](https://github.com/stansz/hive-mcp) package no longer works with this server; a
  built-in `hive mcp` is planned.

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Fastify setup: public routes (the `/` and `/docs` redirects to `/ui/`, `/ui/`, `/health`) and the authenticated API scope |
| `src/config.ts` | All env-var config, provider table (`PROVIDERS`) |
| `src/keys.ts` | Provider keys in one private file (mode 600, atomic rename), masked display, lookup precedence (shell env > keys file > `.env`) and the key check per provider |
| `src/auth.ts` | Bearer tokens (`API_TOKEN` / `API_TOKENS`), one-time WebSocket tickets |
| `src/web-runs.ts` | The web UI's run routes over `src/runs.ts`: `/prompt` (new runs and follow-ups), `/runs`, `/status`, `/abort`, `/session`, `/pr`, `/issue`, `/events` (WebSocket with replay); the run queue (`createSlots`); auto-push of a finished run's branch |
| `src/stall.ts` | Stall watchdog: stop a run when nothing in `work/` changed and no event arrived for `HIVE_STALL_MIN` minutes |
| `src/openrouter.ts` | OpenRouter runs: pi's `models.json` from OpenRouter's model data, and a fixed provider order (maker first, then uptime, then price; low-precision endpoints skipped) |
| `src/sandbox.ts` | `pasta` + `hive-vm` wrapper for the libkrun microVM (the only backend); the VM writes its events to a mounted `io/` folder that the host follows; `systemInfo()` for the UI |
| `src/git.ts` | Host-side git on the pristine clone only: clone, new-repo setup, `git am` the patches, push, change summary; `gh` helpers for the login, `gh repo create` and `gh pr create` |
| `src/cli.ts` | `hive` CLI: argument parsing and command dispatch (run/new/continue/log/diff/apply/push/list/clean/keys/serve/service); sets the commit identity from the user's git config |
| `src/service.ts` | `hive service`: systemd user unit (Linux) or launchd agent (macOS) that runs `hive serve` at login/boot. Pure file builders (`systemdUnit`, `launchdPlist`, `servicePaths`), plus thin runners for `systemctl` / `launchctl`; tests set `HIVE_SERVICE_DIR` and never touch the real system |
| `src/runs.ts` | The run engine: run folders and `meta.json`; sources (your checkout, a URL, a new empty repo); agent steps in the VM (time note, stall watchdog, `finalStatus`); review cycles; follow-ups (`continueRun`); export of committed work whatever the outcome; push (a new branch, or updating the run's own branch after a follow-up; a new project creates its GitHub repo); `gh pr create`; startup cleanup (`recoverRuns`) and retention (`pruneRuns`) |
| `src/follow.ts` | Polls a JSONL file by byte offset (the VM's `io/events.jsonl`); opens it with `O_NOFOLLOW` |
| `src/render.ts` | Plain-text rendering of pi events plus token/cost totals |
| `src/routes/github.ts` | `gh`-backed repo list and branches for the UI |
| `src/routes/providers.ts` | `/api/providers` and `/api/models` for the UI |
| `src/routes/system.ts` | `/api/system` (sandbox setup and checks) and `/api/system/usage` (live CPU, memory, disk, temperature, runs) for Settings › This computer |
| `src/usage.ts` | `usageNow()`: the live numbers behind the UI's Resources section, reading `/proc` and `/sys` under a configurable root |
| `src/routes/keys.ts` | `/api/keys`: list (masked), add (tested first), test, remove and make-default provider keys for Settings › API keys |
| `src/models.ts` | Model lists per provider (OpenRouter's live list, cached 1 h) |
| `image/` | The sandbox image: pi (pinned `PI_VERSION`), `hive-agent` (runs pi), `hive-export` (format-patch), `hive-vm-init` (libkrun guest init) |
| `vm/` | libkrun backend: `hive-vm.c` (launcher), `build.sh`, `build-rootfs.sh` |
| `ui/` | Vite + vanilla TS web UI, built to `ui/dist`: `main.ts` (Runs: form, timeline, result; Settings: API keys, This computer), `bee.ts` (the run indicator), `util.ts` (`el()`, `esc()`, `api()`), `app.css` (light and dark tokens) |
| `scripts/` | `run-tests.mjs` (test runner with a throwaway `TMPDIR`), `ui-smoke.mjs` (headless browser check with a faked run), release build and signing |

Build: `npm run build` (server), `npm run build:ui`, `npm run build:image`; for the libkrun
backend also `npm run build:vm` and `npm run build:rootfs`. Run the tests with `npm test`.

## Security model — keep these invariants

1. **The sandbox gets nothing secret except one LLM key.** A VM shares only its own run's `work/`
   and `io/` (plus `out/` for export) and the shared VM cache, never the run folder itself (it
   holds `origin/`, which the host pushes from). Keys are passed with `-e NAME` from the child env, never
   on the command line. Don't add host mounts or env vars casually. A VM can have at most 5 shared
   folders (libkrun's interrupt slots); `runSandbox` refuses more. The libkrun backend maps no guest ports to the
   host and runs in a pasta namespace that cannot reach the host's loopback, gateway or own
   addresses; its root is a read-only export of the image with an in-RAM overlay.
2. **The host never runs git in `work/`.** The agent controls `work/.git` (hooks, config,
   filters, fsmonitor). Host git runs only in `origin/`, which no sandbox mounts, with hooks
   disabled. Changes cross over only as patch files applied with `git am`.
3. **Every API route lives inside the authenticated scope** in `index.ts`. Don't add path-based
   auth exceptions.
4. **Anything from GitHub or the agent is untrusted in the UI** — render with `esc()` only.
5. Repo URLs are restricted to github.com (`normalizeRepo`); `HIVE_ALLOW_ANY_REPO_URL=1` is for
   local testing only.
6. **The VM cache is the one thing shared between tasks.** `HIVE_VM_CACHE` (default
   `~/.cache/agent-hive/vm-cache`) is mounted read-write at `/root/.cache` in every agent sandbox,
   so it must never hold credentials or task data. npm's cache lives inside it
   (`NPM_CONFIG_CACHE=/root/.cache/npm`).
7. **The CLI's host git runs only in the user's repo** (rev-parse, status, clone source, apply/am
   of exported patches), never in a run's `work/`. Text crosses into and out of the VM only as
   files in `io/` and patches in `out/`.
8. **Files the VM writes are read without following symlinks.** The host reads `io/events.jsonl`
   and `io/stderr.log` with `O_NOFOLLOW`, so the agent can't point the host at its own files. The
   launcher log (`<run>/io.launcher.log`) sits outside the VM-writable `io/` folder for the same
   reason.
9. **Nothing reaches GitHub on the agent's say-so.** Branch pushes and new repos happen in the host
   after the run; pull requests and issues only when the user asks (`POST /pr/:id`, `/issue/:id`). `gh` and `git` run with
   argument arrays, never a shell.
10. **Provider keys are written only to the keys file** (`~/.config/agent-hive/env`, mode 600, atomic
    rename). They are never logged or returned whole (the UI and API only see a masked form), and a
    value is validated (`^[\x21-\x7E]{1,400}$`, no quotes, `#`, `\` or backticks) before it is
    written so it cannot inject another `NAME=value` line.
11. **A VM never outlives its time limit, and a crashed hive leaves no VM behind.** The launcher
    (`vm/hive-vm`) gets the time limit (`--timeout`) and stops the VM itself when it passes, even if
    the CLI or server died. Its owner check (`--watch-pid`) exists but isn't used: under pasta the
    launcher is in its own PID namespace and can't see the owner. Instead, at start the server and
    the CLI run `recoverRuns()`: a run still marked running whose owner is gone has its leftover
    `hive-vm` stopped and is marked "interrupted". The stall watchdog stops a run that makes no
    progress for `HIVE_STALL_MIN` minutes.

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
| **<bot>** | Hive's bot account | `gh` CLI login | Repo list and branches, pull requests, new repos |

In the `ssh` setup a compromised server exposes the bot account and the per-repo deploy keys, not
full access to the owner's GitHub. The sandbox gets neither in either setup.

- **Your repos:** task with `repo=<owner>/<repo>` → host clones → agent works in the sandbox →
  host pushes `hive/<id>`. Open a PR from the UI's **Open pull request** button
  (`POST /pr/:id`, via `gh pr create`), or merge yourself.
- **External repos:** fork it yourself (for example with `gh repo fork`), then run the task on
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

**Done, run engine (CLI and server alike):** runs on your checkout, a `--repo` URL or a new empty
repo; follow-ups in the same pi session (`hive continue`); review cycles with an optional second
model (`--review`, `--review-model`); a queue (`MAX_CONCURRENT_SESSIONS`); the stall watchdog, the
time limit and a deadline note to the agent; committed work kept on a timeout, stall, failure or
stop; success read from pi's last message (`stopReason`); startup cleanup of leftover VMs; finished
runs deleted after `HIVE_RUN_RETENTION_DAYS` (14); OpenRouter routing and `models.json`; the shared
VM cache (`~/.cache`, npm inside it); the Fedora VM image with headless Chromium and corepack.

**Done, CLI:** `run`, `new`, `continue`, `log`, `diff`, `apply`, `push` (a new branch, never
forced; updates the run's own branch after a follow-up), `push --pr`, `list`, `clean`, `keys`,
`serve` and `service`. Settings come from env vars or `~/.config/agent-hive/env`.

**Done, server and web UI:** `hive serve` over the same engine, so runs survive restarts and the web
run list shows CLI runs too. The new design (light and dark): Runs (new-run form with repo and
branch lists, per-provider model lists, review cycles, New project; the bee indicator, a timeline
with step check-offs, the result with commits, files, Open pull request and Post review as an
issue; follow-ups) and Settings (API keys: Add, Test, Make default, Remove; This computer, with the
checks, GitHub, a live Resources section and limits). Checked by `scripts/ui-smoke.mjs`.

**Not built yet:**
- web UI: the first-run onboarding from `docs/GUI.md`
- server: refusing to restart, or finishing runs first, while runs are in progress
- `hive mcp` (stdio MCP for handing work to hive from other agents)
- releases: the first signed release, bundled libkrun (step 2), the beta channel and the weekly
  update check (`docs/ROADMAP.md`)
- macOS: the launcher build for Apple silicon, and network isolation without pasta
- a per-run network allowlist
