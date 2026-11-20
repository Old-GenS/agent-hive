# GUI: first run and key setup (design)

Clickable mockup: https://claude.ai/artifact/7aZcD6LT5b12cG5VAzC1v7 (press Play on either screen).

## Built so far

The web UI (`ui/`) uses the mockup's look: light and dark themes, the hexagon logo, Runs and
Settings in the header.

- **Runs** (not in the mockup): the new-run form, the bee run indicator, the timeline and the result
  with commits, files changed and Open pull request. See the README's "Web UI" section.
- **Settings › API keys:** the table from screen 2, built: each provider's key masked, where it
  comes from, its status and default model, and which provider is the default. **Add key** tests
  the key before saving it; **Test**, **Make default** and **Remove** (with an inline
  confirmation) work on each saved key. The storage is the private file; there is no keychain
  choice yet.
- **Settings › This computer:** the checks from step 2 of screen 1 (KVM, libkrun, pasta, launcher,
  VM filesystem) plus the GitHub connection and limits. No rootfs download from the UI yet.
- **Not built:** the first-run screens (screen 1).

## Screen 1: first run

1. **Welcome:** what hive does, in three points.
2. **Check this computer:** the `hive doctor` checks (KVM, libkrun, pasta), plus a **Download**
   button with progress for the VM filesystem. A failed check shows the exact install command.
3. **Add a model key:**
   - pick a provider, paste the key, then **Test key** (it only continues once the key works);
   - choose where to keep it;
   - set the default model, prefilled per provider.
4. **GitHub (optional):** detects the `gh` login. Choose the `gh` login (push and PRs), git
   credentials only, or local repos only.
5. **Ready:** a summary, plus the first commands to try.

## Screen 2: Settings › API keys

Each provider's key is shown masked, with its status and default model.

- **Test**, **Make default** and **Remove** on each key, with a confirmation before removing.
- **Add key**, which tests the key before saving it.
- A note on where keys are kept, and the matching CLI commands.

## Key storage

Keys live in a private file only the user can read (mode 600),
`~/.config/agent-hive/env`, which works on servers and after reboots; both the CLI and the server
read it. An exported environment variable wins over a saved key. The system keychain is not
offered: it stays locked after a reboot if nobody logs in at the desktop, and a headless box
can't unlock it.

## CLI

`hive keys add | list | test | remove | default` is built, and the GUI manages the same file
through the server's `/api/keys` routes.

## Ideas from other projects

See `docs/RESEARCH.md`: opencode's client/server split (the GUI as a client of `hive serve`),
OpenHands' action timeline, interrupt button and file-changes view, and Open WebUI's
"test connection" button on provider settings (ideas only; its license limits reuse).
