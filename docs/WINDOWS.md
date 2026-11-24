# Windows (WSL2)

hive runs inside a Linux microVM, so on Windows it runs inside WSL2: one PowerShell line installs
a small Ubuntu distro dedicated to hive (it never touches your other distros) and gets hive
working without any Linux prompts.

```powershell
irm https://raw.githubusercontent.com/Old-GenS/agent-hive/main/install.ps1 | iex
```

## Requirements

- **Windows 11**, or Windows 10 22H2 with WSL installed from the Microsoft Store.
- Hardware virtualization on in the BIOS/UEFI (Intel VT-x / AMD-V). WSL2 needs it to pass
  `/dev/kvm` through to the distro.
- A one-time download of a few hundred MB for the distro and about 660 MB for the VM filesystem.

Tested on Windows 11 with WSL 2.6, kernel 6.18.58.1-microsoft-standard-WSL2 and Ubuntu 24.04.

## What the installer does

1. Checks that WSL is installed (`wsl.exe --status`). If it isn't, it prints the Administrator
   command to run (`wsl --install --no-distribution`) and asks you to restart Windows and run the
   installer again. Then it runs `wsl --update` (best effort).
2. Creates the `agent-hive` distro from `Ubuntu-24.04` with `--no-launch`, or reuses it when it
   already exists.
3. Creates a Linux user (your Windows user name, lowercased) as root, so the first-launch
   questions never appear: adds it to the `kvm` and `sudo` groups, asks once for a password for
   `sudo` (sent to `chpasswd` over standard input, never on a command line), and writes
   `/etc/wsl.conf` with `systemd=true` and that user as the default.
4. Installs `passt` (pasta), `gh`, `wslu` (for `wslview`), `git`, `curl` and `ca-certificates` with
   `apt-get`.
5. Restarts the distro so the groups and `/etc/wsl.conf` apply.
6. Checks `/dev/kvm`. If it is missing, it backs up `%UserProfile%\.wslconfig`, sets
   `nestedVirtualization=true` under `[wsl2]` (keeping your other settings), runs `wsl --shutdown`
   and checks again. Still missing means virtualization is off in the BIOS/UEFI, or the CPU does
   not support it, and the script stops with that message.
7. Runs `install-cli.sh` inside the distro as your user: it downloads the release, the VM
   filesystem (with progress), puts `~/.local/bin` on the Linux `PATH` and prints the checks for
   KVM and pasta.
8. Writes `%LOCALAPPDATA%\agent-hive\bin\hive.cmd`, which forwards to hive inside the distro, and
   adds that folder to your user `PATH`, so `hive` works from PowerShell.
9. Prints the next steps.

The script never runs `sudo` from Windows and never touches your other distros.

## Environment variables

The `irm | iex` form cannot pass parameters, so set environment variables instead:

| Variable | Meaning |
|----------|---------|
| `HIVE_WSL_DISTRO` | The WSL distro to create or reuse (default `agent-hive`). |
| `HIVE_WSL_USER` | The Linux user inside it (default: your Windows user name, lowercased, with anything outside `a-z0-9_-` removed). |
| `HIVE_UNINSTALL=1` | Same as `-Uninstall`: remove the distro and the `hive` command. |
| `HIVE_INSTALL_CLI_URL` | The `install-cli.sh` URL to run (for testing). |

```powershell
$env:HIVE_WSL_DISTRO = 'agent-hive-test'; irm https://raw.githubusercontent.com/Old-GenS/agent-hive/main/install.ps1 | iex
```

## Using hive

From PowerShell, `hive` goes through `hive.cmd` into the distro. Everything in the
[CLI reference](CLI.md) works:

```powershell
hive doctor
hive keys add openrouter
cd \\wsl$\agent-hive\home\<user>\code\my-app
hive run "add input validation to the signup form"
```

Inside WSL, the same commands work directly (which is where you'll want to be for `git` and
`gh`):

```powershell
wsl -d agent-hive --cd ~
```

Keep **projects in the Linux home folder**, for example `\\wsl$\agent-hive\home\<user>\code`, not
under `C:\`: files under `/mnt/c` are much slower and make builds crawl.

### GitHub

The release installer installs `gh`. To use it for new projects, pushes and pull requests, log in
once inside WSL:

```powershell
hive login github
```

Or press **Connect GitHub** in the web UI's first-run setup (step 4) or Settings › API keys,
which shows the one-time code on the page. `gh auth login` inside WSL works too.

(Your Windows `gh` login is not shared; see [GitHub access](SERVER.md#github-access) for the
server-side alternatives.)

### Web UI

```powershell
hive serve
```

`hive serve` opens `http://127.0.0.1:8080/ui/` in your Windows browser (`wslu` provides
`wslview`). Runs from PowerShell and from inside WSL share one list.

## Updating and uninstalling

Updating works the same as on Linux:

```powershell
hive update
```

To remove hive from inside WSL but keep the distro, run `hive uninstall` (it asks first, and keeps
runs and saved keys unless you pass `--all`; `--dry-run` only shows what would go).

To uninstall the whole thing, run the installer again with `-Uninstall`, or set
`HIVE_UNINSTALL=1` before piping it. It asks for confirmation, then deletes the `agent-hive`
distro and everything in it (projects, keys, runs), removes `%LOCALAPPDATA%\agent-hive\bin` and
its user `PATH` entry. It leaves
`%UserProfile%\.wslconfig` alone; if this install changed it, the backup is
`%UserProfile%\.wslconfig.hive-backup`.

```powershell
$env:HIVE_UNINSTALL = '1'; irm https://raw.githubusercontent.com/Old-GenS/agent-hive/main/install.ps1 | iex
```

## Troubleshooting

- **`/dev/kvm` is missing.** Inside the distro, `ls -l /dev/kvm` should show `crw-rw---- root kvm`.
  If it does not, WSL2 has no nested virtualization: add `nestedVirtualization=true` under
  `[wsl2]` in `%UserProfile%\.wslconfig` and run `wsl --shutdown` (the installer does this
  itself). If it is still missing, turn on virtualization in the BIOS/UEFI.
- **hive can't read `/dev/kvm`.** Add yourself to the group and restart the distro:
  `sudo usermod -aG kvm $USER`, then from Windows `wsl --shutdown`.
- **pasta is missing.** `sudo apt install -y passt`. Release builds also bundle a static copy, so
  hive falls back to it.
- **`hive: command not found`.** Open a new terminal (the installer adds `~/.local/bin` to the
  Linux `PATH`), or run `. ~/.profile`.
- **`hive uninstall` says permission denied.** A run started with `sudo` leaves root-owned files
  in the cache; the uninstall names each one, removes everything else first, and prints the
  `sudo rm -rf` line that finishes the job. A background service it cannot stop (a distro with no
  systemd user session) is skipped instead of blocking the rest.
- **Check everything at once:** `hive doctor` reports KVM, pasta, libkrun and the VM filesystem,
  with the fix for anything that is missing.

## Installing by hand (any existing distro)

If you already have a WSL distro and would rather not use the installer, the tested steps are:

```powershell
wsl --update
wsl --install Ubuntu-24.04 --name agent-hive
```

```bash
ls -l /dev/kvm                      # needs crw-rw---- root kvm
sudo usermod -aG kvm $USER          # only if /dev/kvm isn't readable; then wsl --shutdown
sudo apt install -y passt
curl -fsSL https://raw.githubusercontent.com/Old-GenS/agent-hive/main/install-cli.sh | sh
hive doctor
hive keys add openrouter
```

`gh` and `wslu` are not installed by default; add them with `sudo apt install -y gh wslu` if you
want GitHub operations and the browser opening from `hive serve`.
