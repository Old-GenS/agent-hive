# Web UI and server

`hive serve` runs a small HTTP server with a web UI and an API on top of the same run engine as the
CLI. Use it from a browser on the same machine, or from a phone or another computer.

## Starting it

```bash
hive serve                       # http://127.0.0.1:8080/ui/
hive serve --open                # also opens the browser, already logged in
hive serve --host 0.0.0.0 --port 9000
```

On first start it creates a login token, saves it in `~/.config/agent-hive/env` as `API_TOKEN`
and tells you where it is (the token itself is never printed). `--open` hands it to the browser
in the URL fragment, which the UI reads and removes from the address bar.

It listens on `127.0.0.1` by default. To use it from other devices, put it behind a tunnel or a
TLS reverse proxy. `HOST=0.0.0.0` also works on a trusted home network, but that's plain HTTP:
the token crosses the network unencrypted.

From a source checkout, build the UI first: `npm run build && npm run build:ui`. A running server
picks up a rebuilt UI without a restart.

## Running it in the background

```bash
hive service install      # systemd user unit on Linux, launchd agent on macOS
hive service status
hive service restart
hive service logs
hive service uninstall
```

`install` takes `--host` / `--port`, and `--dry-run` prints the unit file without installing it.
On a headless Linux box, also run the `sudo loginctl enable-linger <user>` line it prints, or the
service stops when you log out.

The service doesn't inherit your shell, so provider keys must be saved in the keys file
(`hive keys add`); `install` warns about keys it can only see in your shell.

**Restarts:** finished runs are folders on disk, so they survive a restart. Runs in progress are
stopped by a restart and marked "interrupted" when the server starts again; their committed work
is kept.

## The web UI

**First run:** a new user with no model key, or a machine that isn't set up, lands on `#setup`
(Welcome → Check this computer → Add a model key → GitHub → Ready). A failed check shows the
command that fixes it for this distro, and WSL gets its own advice. An installed release whose VM
filesystem is missing offers **Download VM filesystem** with progress. Every step can be skipped,
and Settings has **Run setup again**. `hive doctor` prints the same fixes in the terminal.

**Runs**

- **New run:** the task; an existing repo (picked from your GitHub repos via `gh`, with its
  branches) or a new project; provider (only those with a key), model, thinking level and review
  cycles.
- **While it runs:** a bee shows the VM at work (it rests while queued, lands when done, greys out
  on failure), with a timer and the cost so far. The timeline shows the agent's messages, rendered
  as Markdown, and each tool step. **Stop** ends the run.
- **Follow-ups:** the message box under a finished run continues the same session.
- **When it's done:** the agent's final message, the commits and files changed, and buttons for
  **Open pull request**, **Download zip** and **Download report**. Nothing is opened on GitHub
  until you click.
- **Run list:** every run, from the web UI or the terminal, newest first, with its status and
  time. Each run has its own link (`/ui/#runs/<run>`).

Each repo run pushes its commits to a `hive/<run>` branch when it finishes (never `main`). For a
review that shouldn't change anything, say "don't edit or commit" in the task; when nothing
changed, **Post review as an issue** puts the agent's findings into a GitHub issue.

**New project** starts from an empty repo with the name you give; when the run has commits, the
host creates that GitHub repository (private by default) and pushes to its `main`. No commits, no
repository.

**Settings**

- **API keys:** each provider's key (masked), where it comes from, its default model, and which
  provider is the default. **Add key** tests a key before saving it; saved keys can be tested,
  made the default or removed.
- **This computer:** how runs are isolated, the checks behind it (KVM, libkrun, pasta, launcher,
  VM filesystem), the GitHub login, a live **Resources** section (CPU, memory, disk, temperature,
  runs) and the limits.

The header has a light/dark toggle and Log out.

## GitHub access

By default the server clones and pushes over HTTPS with the machine's `gh` login, which also lists
your repos, opens pull requests and creates new repositories. For several servers, per-repo SSH
deploy keys and a separate bot account work too (`HIVE_GIT_PROTOCOL=ssh`); see
[AGENTS.md](../AGENTS.md#github-access-server). The VM never gets any of these credentials.

## API

Every endpoint except `/health` needs `Authorization: Bearer <token>`.

| Method | Endpoint | What it does |
|--------|----------|--------------|
| POST | `/prompt` | Start a run (`prompt`, `repo`, `branch`, `newRepo` `{name, private}`, `provider`, `model`, `thinkingLevel`, `reviewCycles`, `reviewModel`, `systemPromptOverride`), or follow up with `sessionId` |
| GET | `/runs` | Every run, newest first, plus the queue's capacity |
| GET | `/status/:id` | A run's status, branch, commits and files changed, PR and issue links, usage, timing and error |
| POST | `/abort/:id` | Stop a run |
| DELETE | `/session/:id` | Delete a finished run and its files |
| POST | `/pr/:id` | Open a pull request from the run's branch; returns `{url}` |
| POST | `/issue/:id` | Post a no-change run's write-up as a GitHub issue; returns `{url}` |
| GET | `/export/:id?format=zip\|bundle\|report` | Download the result: a zip of the files, a git bundle of the commits (both built on the host from the run's patches), or a Markdown report |
| POST | `/events/:id/ticket` | A one-time ticket (60 s) for the event stream |
| WS | `/events/:id?ticket=…` | pi's events plus `hive_status` and `hive_done`; a finished run is replayed |
| GET | `/capacity` | Runs running and queued |
| GET | `/api/system` | Isolation setup, its checks, the `gh` login, limits |
| GET | `/api/system/usage` | Live CPU, memory, disk, temperature and runs |
| GET | `/api/providers` | Default provider, model and thinking level, and which providers have a key |
| GET | `/api/models?provider=` | Models to offer for a provider |
| GET | `/api/onboarding` | First-run state: whether setup is needed, the system checks with their distro-aware fixes, the key and GitHub status, and the VM filesystem download state |
| POST | `/api/setup/rootfs` | Download the VM filesystem for an installed release (202; progress via `GET /api/onboarding`); 409 when it isn't possible or a download is already running |
| GET | `/api/keys` | Each provider's key status (masked, never the key) |
| POST | `/api/keys` | Test and save a key (`provider`, `key`) |
| POST | `/api/keys/:provider/test` | Test a provider's key |
| DELETE | `/api/keys/:provider` | Remove a saved key |
| PUT | `/api/keys/default` | Make a provider the default (`provider`) |
| GET | `/api/github/repos` | Your repos (via `gh`) |
| GET | `/api/github/branches?repo=owner/name` | A repo's branches, default first |
| GET | `/health` | Health check (no auth) |
