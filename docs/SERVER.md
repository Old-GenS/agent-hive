# Web UI and server

`hive serve` runs a small HTTP server with a web UI and an API on top of the same run engine as the
CLI. Use it from a browser on the same machine, or from a phone or another computer.

## Starting it

```bash
hive serve                       # http://127.0.0.1:8080/ui/, opened in your browser
hive serve --no-open             # don't open a browser
hive serve --host 0.0.0.0 --port 9000
```

On first start it creates a login token, saves it in `~/.config/agent-hive/env` as `API_TOKEN`
and tells you where it is (the token itself is never printed). When there's a desktop (macOS, a
Linux desktop session, or WSL, where the Windows browser opens) and you're not on SSH, `hive serve`
opens the UI and hands the token to the browser in the URL fragment, which the UI reads and removes
from the address bar. `--open` forces that, `--no-open` turns it off; the background service never
opens a browser.

It listens on `127.0.0.1` by default.

**From your phone or another computer on your home network:**

1. `hive serve --host 0.0.0.0`. It prints the addresses it's reachable at, such as
   `http://192.168.1.20:8080/ui/`; open one on the other device.
2. Log in with the token: on the hive machine, `grep API_TOKEN ~/.config/agent-hive/env` and paste
   the part after `API_TOKEN=`.
3. If the page doesn't load, the machine's firewall may block the port: `sudo ufw allow 8080/tcp`
   (Ubuntu, Mint) or `sudo firewall-cmd --add-port=8080/tcp` (Fedora).

That's plain HTTP, so the token crosses your network unencrypted: fine on your own Wi-Fi, not on a
shared network. From outside your home, use a tunnel (Tailscale, for example) or a TLS reverse
proxy rather than opening the port.

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
filesystem is missing offers **Download VM filesystem** with progress. Step 4 has a **Connect
GitHub** button: it starts the GitHub CLI's device login on the server and shows the one-time code
and the `github.com/login/device` link, so you enter the code on your own device and never type a
`gh` command. Every step can be skipped, and Settings has **Run setup again**. `hive doctor` prints
the same fixes in the terminal.

**Runs**

- **New run:** the task; an existing repo (picked from your GitHub repos via `gh`, with its
  branches) or a new project; provider (only those with a key), model, thinking level and review
  cycles.
- **While it runs:** a bee shows the VM at work (it rests while queued, lands when done, greys out
  on failure), with a timer and the cost so far. The timeline shows the agent's messages, rendered
  as Markdown, and each tool step. **Stop** ends the run.
- **Follow-ups:** the message box under a finished run continues the same session.
- **When it's done:** the agent's final message, the commits and files changed, and buttons for
  **Open pull request**, **Download zip** and **Download report**. **Delete** removes a finished
  run and its folder after a confirmation that also warns when its commits were never pushed.
  Nothing is opened on GitHub until you click.
- **Starring:** the ☆ button on any run stars it (★). Starred runs are skipped by retention,
  **Clear…** and `hive clean --all`; they can still be deleted one by one.
- **Run list:** every run, from the web UI or the terminal, newest first, with its status and
  time; starred runs show a ★ next to their title. **Clear…** deletes finished runs in one go —
  finished successfully (the default), or all finished runs including failed and stopped ones.
  Each run has its own link (`/ui/#runs/<run>`).

Each repo run pushes its commits to a `hive/<run>` branch when it finishes (never `main`). For a
review that shouldn't change anything, say "don't edit or commit" in the task; when nothing
changed, **Post review as an issue** puts the agent's findings into a GitHub issue.

**New project** starts from an empty repo with the name you give; when the run has commits, the
host creates that GitHub repository (private by default) and pushes to its `main`. No commits, no
repository.

**Settings**

- **API keys:** each provider's key (masked), where it comes from, its default model, and which
  provider is the default. **Add key** tests a key before saving it; saved keys can be tested,
  made the default or removed. Below them, the **GitHub** login (with **Connect GitHub** when it
  isn't connected: the same device-login flow as setup step 4).
- **Runs:** the VM size (CPUs and memory per run), runs at once, the time limit, the stall time,
  the disk limit per run and how long finished runs are kept, checked against this computer's CPUs
  and RAM. Saved values apply to new runs without a restart; values set in the server's
  environment are shown read-only.
- **This computer:** how runs are isolated, the checks behind it (KVM, libkrun, pasta, launcher,
  VM filesystem), a live **Resources** section (CPU, memory, disk, temperature,
  runs) and the limits, with a link to **Settings › Runs**.

The header has a light/dark toggle and Log out.

## GitHub access

By default the server clones and pushes over HTTPS with the machine's `gh` login, which also lists
your repos, opens pull requests and creates new repositories. Log it in with **Connect GitHub** in
the web UI (first-run setup or Settings › API keys), or with `hive login github`; each starts
the GitHub CLI's device login and shows the one-time code. For several servers, per-repo SSH
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
| DELETE | `/session/:id` | Delete a finished run and its files (starred or not) |
| PUT | `/session/:id/kept` | Star or unstar a run (`kept` boolean); returns `{sessionId, kept}`. Works on live runs |
| POST | `/sessions/clear` | Delete finished runs in one go (`include`: `done` by default, or `finished`); skips live and starred runs; returns `{deleted, skipped}` |
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
| GET | `/api/settings` | The run settings (value, default, limits, where each comes from) and this computer's CPUs and memory |
| PUT | `/api/settings` | Save any of `cpus`, `memoryMiB`, `maxConcurrent`, `timeoutMin`, `stallMin`, `diskMaxGb`; 400 with field errors, 409 for a value set in the server's environment |
| DELETE | `/api/settings/:key` | Reset one setting to its `.env` value or default |
| GET | `/api/github/repos` | Your repos (via `gh`) |
| GET | `/api/github/branches?repo=owner/name` | A repo's branches, default first |
| POST | `/api/github/login` | Start the server's GitHub device login (200 with the state; `waiting` carries the one-time `code` and `url`) |
| GET | `/api/github/login` | The login's state: `idle`, `starting`, `waiting`, `done` (with `login`) or `error` |
| DELETE | `/api/github/login` | Cancel a pending login and return `{state: "idle"}` |
| GET | `/health` | Health check (no auth) |
