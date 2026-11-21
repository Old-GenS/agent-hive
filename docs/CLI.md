# CLI reference

`[run]` defaults to the newest run. Run names look like `<repo>-<YYYYMMDD-HHMMSS>`; `hive list`
shows them.

## Output

In a terminal, `hive` uses colour, a live status line while a run goes (spinner, the current step,
elapsed time, cost and tool count), a line per finished step, tidy tool-call lines, the agent's
Markdown rendered for the terminal, and aligned tables for `hive list` and `hive keys list`.

When output is piped, or `NO_COLOR` is set, every command prints plain text exactly as before, so
scripts and `grep` keep working. `--json` prints pi's raw events, one JSON object per line.
`FORCE_COLOR=1` keeps the colour when output is piped.

When a command needs something you didn't pass and stdin is a terminal, `hive` asks: `hive run`
and `hive new` for a prompt, `hive keys add` and `hive keys default` for a provider, and
`hive clean` for the run to delete (arrow keys and Enter). `hive keep` needs the run name. Without a terminal these are usage
errors, as before.

## Running the agent

| Command | What it does |
|---------|--------------|
| `hive run "<prompt>"` | Clone the repo into a new run, run the agent in a VM with live progress, and export its commits. Ctrl+C stops the run (its committed work is kept). |
| `hive new <name> "<prompt>"` | Start a new project from an empty repository. When the agent has committed, `hive push <run>` creates the GitHub repository (private unless `--public`) and pushes to `main`. |
| `hive continue [run] ["<prompt>"]` | Continue a finished run in the same pi session and on the same copy. The run defaults to the newest one; without a prompt it sends "Continue the task from where you left off; don't redo finished work." Works for runs started from the web UI (`hive serve`) too. Pushing is left to `hive push`. |

Options for `run` and `new`:

| Option | Meaning |
|--------|---------|
| `-m <model>` | Model (default: see [CONFIGURATION.md](CONFIGURATION.md#provider-and-model)) |
| `-p <provider>` | `deepseek`, `zai`, `openrouter`, `anthropic` or `openai` |
| `-t <level>` | Thinking: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--review <n>` | Up to 5 review cycles after the agent finishes (skipped when it made no commits) |
| `--review-model <model>` | A different model for the reviews |
| `-f <file>` | Read the prompt from a file |
| `--json` | Print raw events instead of the readable view |
| `--repo <owner/name\|url>` | `run` only: clone a remote instead of the current repo |
| `--ref <branch>` | `run` only: the branch to clone with `--repo` |
| `--public` | `new` only: create a public repository |

Without `--repo`, `hive run` works on the current repo's `HEAD`; uncommitted changes aren't
included. `--repo` accepts `owner/name` (github.com), an `https://` or `ssh://` URL, or
`git@host:owner/name.git`.

## Looking at results

| Command | What it does |
|---------|--------------|
| `hive list` | List runs, newest first, with status, commits and cost (live while a run goes). Starred runs carry a ★ after the status. |
| `hive log [run]` | Replay a run's events; follows live while it runs. `--json` for raw events. |
| `hive diff [run]` | Show the run's changes. `--stat` for a summary. |

## Taking the work

| Command | What it does |
|---------|--------------|
| `hive apply [run]` | Apply the patches to the current repo as uncommitted changes (the repo must be clean and at the run's base), or `--branch <name>` to put them on a new branch. Local runs only. |
| `hive push [run]` | Push the commits to a new branch with your own git credentials: `--branch <name>` (default `hive/<run>`), `--remote <name>` (default `origin`), `--pr` to open a GitHub pull request, `--base <branch>` for its base. Never forced; after a follow-up it updates the run's own branch. |
| `hive export [run]` | Save the result: a zip of the project files (default), `--bundle` for a git bundle of the commits (`git clone <file>.bundle`), or `--report` for a Markdown report (prompts, the agent's report, errors, commits). `-o <path>` sets the file, `--force` overwrites. |

Zip and bundle are built on your machine from the run's patches in a fresh clone of the original
source, never from the agent's copy. `push --pr` needs a github.com remote and the
[GitHub CLI](https://cli.github.com) (`gh auth login`). Pushes run as you, with your SSH key,
credential helper or `gh` login; none of these ever enter the VM. Commits use your git
`user.name` and `user.email` unless `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` are set.

## Keys and housekeeping

| Command | What it does |
|---------|--------------|
| `hive keys [list]` | Each provider's key (masked), where it comes from and its default model. |
| `hive keys add <provider>` | Save a key (read from stdin or a hidden prompt) after testing it; `--no-test` skips the test. |
| `hive keys test [provider]` | Check one key, or every saved one. |
| `hive keys remove <provider>` | Delete a saved key. |
| `hive keys default <provider>` | Make a provider the default. |
| `hive clean <run>` | Delete a run; `--all` deletes every finished run except starred ones. |
| `hive keep [--off] <run>` | Star a run (★) so retention, the web UI's Clear and `hive clean --all` skip it; `--off` unstars it. |
| `hive doctor` | Check `/dev/kvm`, libkrun, pasta, the launcher, the VM filesystem, and show the default provider and model. |
| `hive setup` | Download the VM filesystem an installed release needs. |
| `hive update` | Install the latest release after checking its signature (`--check` only reports, `--rollback` goes back). `--channel stable\|beta` switches the update channel: `beta` follows the daily signed prereleases. A beta install moving to stable never downgrades; it waits for the next stable release. |
| `hive --version` | Print the installed version (`-V` and `hive version` work too). |

## Server

| Command | What it does |
|---------|--------------|
| `hive serve` | Start the web UI and API (default `http://127.0.0.1:8080/ui/`) and open it in your browser, already logged in, when there is a desktop (not over SSH or from a script; on WSL, the Windows browser). `--open` / `--no-open` force it either way; `--host`, `--port`. |
| `hive service install\|status\|restart\|logs\|uninstall` | Run `hive serve` in the background at login (systemd user unit on Linux, launchd agent on macOS). |

See [SERVER.md](SERVER.md).
