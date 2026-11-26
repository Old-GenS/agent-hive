# GUI: first run and key setup (design)

Clickable mockup: https://claude.ai/artifact/7aZcD6LT5b12cG5VAzC1v7 (press Play on either screen).

## Built so far

The web UI (`ui/`) uses the mockup's look: light and dark themes, the hexagon logo, Runs and
Settings in the header.

- **Runs** (not in the mockup): the new-run form, the bee run indicator, the timeline and the result
  with commits, files changed and Open pull request. The new-run form has a collapsed
  **Instructions for this run** disclosure (with a switch to replace the default instead of adding
  to it). See [SERVER.md](SERVER.md#the-web-ui).
- **Settings › API keys:** the table from screen 2, built: each provider's key masked, where it
  comes from, its status and default model, and which provider is the default. **Add key** tests
  the key before saving it; **Test**, **Make default** and **Remove** (with an inline
  confirmation) work on each saved key. The storage is the private file; there is no keychain
  choice yet.
- **Settings › Runs:** the VM and run limits, and **Agent instructions**: an editable default for
  every run (saved to `~/.config/agent-hive/system-prompt.md`, with **Save**, **Reset to hive's
  default** and a character count). When `HIVE_SYSTEM_PROMPT` sets the default, the text is
  read-only and the buttons are disabled.
- **Settings › This computer:** the checks from step 2 of screen 1 (KVM, libkrun, pasta, launcher,
  VM filesystem) plus the GitHub connection and limits.
- **First run (`#setup`):** screen 1, built as a five-step flow: Welcome → Check this computer →
  Add a model key → GitHub (optional) → Ready. A failed check shows the fix for this distro (and a
  WSL-specific one) with a **Copy** button; an installed release whose VM filesystem is missing
  offers **Download VM filesystem** with a progress bar. Every step has a **Skip setup** link, the
  browser remembers when setup is done, and Settings has **Run setup again**. The flow opens by
  itself on login when there is no model key or a check fails.

## Screen 1: first run

Built at `#setup`; `hive doctor` prints the same fix text and commands.

1. **Welcome:** what hive does, in three points.
2. **Check this computer:** the `hive doctor` checks (KVM, libkrun, pasta, launcher, VM filesystem).
   A failed check shows the exact command for this distro, with **Copy**; WSL gets its own note
   about nested virtualization and the Ubuntu WSL distro the installer creates. An installed release whose VM
   filesystem is missing offers **Download VM filesystem** with a progress bar and **Check again**.
   Next becomes **Continue anyway** when a check fails, so a key can be added first.
3. **Add a model key:** pick a provider, paste the key, then **Test and save** (the key is tested
   before it is written; the server's error shows inline). The default model is shown; **Make
   default** is offered when another provider already has a key. Choosing a keychain instead of
   the private file is not built.
4. **GitHub (optional):** detects the `gh` login; when it isn't connected, it explains that local
   repos still work and shows `gh auth login` in a copy box. The mockup's choice between a `gh`
   login, git credentials only and local repos is not built: hive uses the server's `gh` login (see
   [SERVER.md](SERVER.md#github-access)).
5. **Ready:** a summary (checks, model key, GitHub) and **Start your first run**, which lands on
   Runs with the task box focused; the terminal equivalent (`hive run "<task>"`) is copyable.

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
