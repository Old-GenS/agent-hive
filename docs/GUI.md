# GUI: first run and key setup (design)

Clickable mockup: https://claude.ai/artifact/7aZcD6LT5b12cG5VAzC1v7 (press Play on either screen).

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
- The storage choice, and the matching CLI commands.

## Key storage

The default is a private file only the user can read (mode 600), which works on servers and after
reboots. The system keychain is an option, with a warning that it stays locked after a reboot if
nobody logs in at the desktop (a headless box can't unlock it).

## CLI it needs

`hive keys add | list | test | remove`, not built yet. The GUI calls the same commands.

## Ideas from other projects

See `docs/RESEARCH.md`: opencode's client/server split (the GUI as a client of `hive serve`),
OpenHands' action timeline, interrupt button and file-changes view, and Open WebUI's
"test connection" button on provider settings (ideas only; its license limits reuse).
