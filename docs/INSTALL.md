# Installing hive

- [What you need](#what-you-need)
- [Linux](#linux)
- [Windows 11](#windows-11)
- [From source](#from-source)
- [After installing](#after-installing)
- [Updating](#updating)
- [Uninstalling](#uninstalling)

## What you need

- **KVM** (`/dev/kvm`): a regular PC or a server with virtualization turned on in the BIOS/UEFI.
  Your user needs access to it: `sudo usermod -aG kvm $USER`, then log out and back in.
- **pasta**, from your distro's `passt` package when it has one. Releases also bundle a static
  copy for distros without one (Ubuntu 22.04, Debian 11, RHEL 8).

  | Distro | Command |
  |---|---|
  | Debian, Ubuntu, Mint | `sudo apt install passt` |
  | Fedora, RHEL | `sudo dnf install passt` |
  | Arch | `sudo pacman -S passt` |

- **An API key** for at least one model provider: DeepSeek, Z.AI, OpenRouter, Anthropic or OpenAI.
- **The GitHub CLI** (`gh`) is optional: it lets hive list your repos, push branches, open pull
  requests and create new repos.

Releases bring their own Node.js and libkrun, and work on Ubuntu 20.04+, Debian 11+, RHEL/Alma/Rocky
8+, Fedora, Mint, Arch and WSL2. Tested on Fedora 45, Linux Mint 22.1, Windows 11 (WSL2, Ubuntu
24.04), and in Ubuntu 22.04 and 24.04 containers. macOS is on the [roadmap](ROADMAP.md).

## Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Old-GenS/agent-hive/main/install-cli.sh | sh
```

The script downloads the latest release, checks it against the release's `SHA256SUMS`, installs it
under `~/.local/share/agent-hive`, puts `hive` in `~/.local/bin` (adding that folder to your PATH in
`~/.profile` if needed; set `HIVE_NO_MODIFY_PATH=1` to skip that) and downloads the VM filesystem
(about 660 MB, once). At the end it tells you if the `kvm` group or `passt` is missing.

## Windows 11

Runs through WSL2. One line in PowerShell (not as administrator):

```powershell
irm https://raw.githubusercontent.com/Old-GenS/agent-hive/main/install.ps1 | iex
```

It creates a dedicated `agent-hive` WSL distro (Ubuntu 24.04) with no Linux prompts, installs hive
inside it and adds a `hive` command to PowerShell. If you already use WSL with Ubuntu, you can
instead install into it like on Linux:

```bash
sudo apt install -y passt gh wslu
sudo usermod -aG kvm $USER        # then run wsl --shutdown in Windows and reopen Ubuntu
curl -fsSL https://raw.githubusercontent.com/Old-GenS/agent-hive/main/install-cli.sh | sh
```

Details, options and troubleshooting: [WINDOWS.md](WINDOWS.md).

## From source

Also needs Node.js 20+, git, podman and the system libkrun (Fedora: `sudo dnf install libkrun`).

```bash
git clone https://github.com/Old-GenS/agent-hive.git && cd agent-hive
npm ci && npm run build && npm run build:ui
npm run build:image && npm run build:vm && npm run build:rootfs
npm link            # puts `hive` on your PATH
```

Update with `git pull` and the same build commands. `hive update` is for release installs only.

## After installing

```bash
hive doctor                       # checks KVM, libkrun, pasta, the launcher and the VM filesystem
hive keys add openrouter          # or deepseek, zai, anthropic, openai
hive login github                 # optional: repos, pushes, pull requests
```

`hive serve` starts the web UI, which walks you through the same steps on first start. See
[SERVER.md](SERVER.md) for using it from other devices and running it as a service.

## Updating

```bash
hive update                       # installs a newer release after checking its signature
hive update --check               # only says whether one is available
hive update --rollback            # goes back to the previous version
hive update --channel nightly     # follow the daily signed prereleases (--channel stable to go back; dev and beta are aliases)
```

How new versions are checked, tested and released: [UPDATES.md](UPDATES.md). Restart a running server afterwards (`hive service restart`, or stop and start `hive serve`). The
VM filesystem is only downloaded again when a release changes it.

## Uninstalling

```bash
hive uninstall             # shows the plan, then asks before removing anything
hive uninstall --yes       # no questions; runs and saved keys/settings are kept
hive uninstall --yes --all # also remove runs and saved keys/settings
hive uninstall --dry-run   # only show what would be removed
```

It stops and removes the background service, the app and its VM filesystem
(`~/.local/share/agent-hive`), the download cache and the VM cache (`~/.cache/agent-hive`), and
the `~/.local/bin/hive` symlink. Your runs (`~/.cache/agent-hive/runs`, or `HIVE_RUNS_DIR`) and
saved API keys and settings (`~/.config/agent-hive`) are kept unless you answer yes to their
questions or pass `--all`; `--keep-runs` / `--keep-config` always keep them. A copy that runs from
a source checkout is left where it is.

If hive can no longer run, or you want to remove it by hand:

```bash
hive service uninstall 2>/dev/null    # if you installed the background service
rm -f ~/.local/bin/hive
rm -rf ~/.local/share/agent-hive      # app versions and the VM filesystem
rm -rf ~/.cache/agent-hive            # runs and the download cache
rm -rf ~/.config/agent-hive           # saved keys and settings
```

Then remove the `# added by agent-hive` line from `~/.profile` (and `~/.bashrc`). With the
Windows installer, everything lives in its own distro: see
[WINDOWS.md](WINDOWS.md#updating-and-uninstalling).
