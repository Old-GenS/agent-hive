# Roadmap

Decisions and next steps for the `hive` CLI. Each step ships on its own, tested on a real machine.
`main` is stable; `beta` carries the newest dependencies before they're fully tested (see
"Keeping it up to date").

## Step 1 — Releases, `hive update`, system libkrun *(done: v0.4.0)*

The first signed release, v0.4.0, is published and was tested end to end on a fresh home folder:
`install-cli.sh`, `hive setup`, `hive doctor`, a real run, `hive update --check` and `hive serve`.
The release key's private half lives only on the release machine
(`~/.config/agent-hive/release-signing-key.pem`); `docs/RELEASING.md` has the steps for the next
release.

- **Release build** (`scripts/build-release.sh`): an app bundle containing `bin/hive`, a bundled
  Node, the `hive-vm` launcher and the CLI as one bundled file. The VM filesystem (rootfs) ships as
  a separate download. A `SHA256SUMS` file covers both and is signed with an ed25519 release key.
- **`install-cli.sh`:** installs the latest release into
  `~/.local/share/agent-hive/versions/<version>`, links `~/.local/bin/hive`, then runs
  `hive setup`.
- **`hive setup`** downloads the rootfs if it's missing. **`hive doctor`** shows what's available.
- **`hive update`:**
  1. Checks the latest GitHub release.
  2. Verifies the signature and the checksums.
  3. Unpacks into a new version folder.
  4. Downloads the rootfs only when its version changed.
  5. Switches `current` in one step and keeps `previous`.
  
  `hive update --rollback` goes back to `previous`, and `--check` only reports. While installed,
  `hive` mentions a newer version at most once a day (`HIVE_NO_UPDATE_CHECK=1` turns that off).
- **libkrun and pasta come from the system** in this step (Fedora: the `libkrun` and `passt`
  packages).

## Step 1b — Windows through WSL2 *(next)*

Done before step 2, because it needs no bundling: Fedora packages libkrun, and WSL2 passes
`/dev/kvm` through with nested virtualization (on by default on Windows 11). Other WSL distros
(Ubuntu) wait for step 2's bundled libkrun; Windows without KVM waits for step 3.

**1. Manual test first.** Nobody has tried libkrun and pasta inside WSL yet; if nested KVM or pasta
networking fails there, the installer below has nothing to stand on. Done by hand in a distro
named `agent-hive`, so it is also a dry run of what the installer automates:

```powershell
wsl --update
wsl --list --online                                   # newest FedoraLinux-<version>
wsl --install FedoraLinux-<version> --name agent-hive
```

```bash
ls -l /dev/kvm                       # must exist; if not, nestedVirtualization=true below
sudo usermod -aG kvm $USER           # if /dev/kvm isn't readable; then wsl --shutdown
sudo dnf install -y libkrun passt
curl -fsSL https://raw.githubusercontent.com/ogsapps/agent-hive/main/install-cli.sh | sh
hive doctor && hive keys add openrouter
cd ~ && hive new wsl-test "a hello world web page in one HTML file"
hive serve                           # then http://127.0.0.1:8080/ui/ in the Windows browser
```

Projects belong in the Linux home folder, not `/mnt/c` (much slower). `hive serve` opens the Windows
browser (`wslview`, else `cmd.exe /c start`); untested so far. `hive service install` needs
systemd in WSL; plain `hive serve` is enough for the test. Whatever breaks feeds the setup
screens (`src/fixes.ts` already has WSL advice) and the installer.

**2. `install.ps1`, a one-line Windows installer** (the same pattern as Bun, Deno and uv):

```powershell
irm https://raw.githubusercontent.com/ogsapps/agent-hive/main/install.ps1 | iex
```

1. **WSL:** if missing, `wsl --install --no-distribution` (needs admin and a reboot; the script
   says so and asks to be run again afterwards).
2. **A dedicated `agent-hive` distro** from the official Fedora WSL image. It sits next to the
   user's own distros and never touches them; uninstalling is `wsl --unregister agent-hive`.
3. **Setup without the first-launch questions:** as root in the distro, create the user, add it
   to `kvm`, `dnf install libkrun passt`, turn on systemd in `/etc/wsl.conf`, then run
   `install-cli.sh` as the user.
4. **`/dev/kvm`:** if missing, add `nestedVirtualization=true` under `[wsl2]` in
   `%UserProfile%\.wslconfig` (keeping a backup and the existing settings), `wsl --shutdown`, and
   check again; still missing means virtualization is off in the BIOS/UEFI, and the script says so.
5. **`hive` in PowerShell:** a `hive.cmd` on the Windows `PATH` that forwards to
   `wsl -d agent-hive -- hive ...`, so `hive serve` gives the web UI in the Windows browser.

The script is written once the manual test works, and tested on a real Windows machine (CI can
only check its syntax). The README then gets a Windows install line.

**3. Later, maybe: a ready-made WSL image.** Newer WSL installs a distro from a file
(`wsl --install --from-file`). An `agent-hive.wsl` image with Fedora, libkrun and hive already
inside would be one download with no package installs, but it is another large file to rebuild
for every security update, so only once the script has proven itself.

## Step 2 — Bundle libkrun, libkrunfw and pasta

This is what makes `hive` work beyond Fedora (Ubuntu, Debian, WSL2 with nested virtualization).

- **Fedora's libkrun can't be copied into a bundle.** It links pipewire, virglrenderer, libepoxy
  and libdrm (GPU and sound features), and needs glibc 2.44.
- **libkrun has to be built from source,** with no GPU or sound features, inside an Ubuntu 22.04
  container (glibc 2.35, which runs on most distros from the last few years). It's Rust and takes
  about 5–10 minutes per build. Upstream publishes no libkrun binaries.
- **libkrunfw (the guest kernel):** download upstream's prebuilt `libkrunfw-x86_64.tgz` from
  github.com/containers/libkrunfw releases. It's about 24 MB.
- **pasta:** build it statically from passt.top (simple C, `make static`), or use upstream's
  builds.
- The bundle gets `lib/` (libkrun and libkrunfw) and `libexec/pasta`. The launcher already loads
  libkrun from `HIVE_LIBKRUN`, and libkrun finds libkrunfw via `LD_LIBRARY_PATH=<bundle>/lib`.
- **Backend scan, in this order:**
  1. system libkrun, so distro security updates apply;
  2. bundled libkrun;
  3. (step 3) gVisor;
  4. otherwise stop with a clear message. Never fall back silently to plain containers.
  
  Each run prints which one it picked, e.g. `isolation: microvm (system libkrun)`, and
  `hive doctor` explains why.
- **Cost of this step:** whoever publishes releases has to rebuild them for libkrun security
  fixes, and the download grows by about 30 MB. "Keeping it up to date" below automates that.

## Keeping it up to date

A release bundles or builds on pieces that each move on their own:

| Piece | Source | Changes |
|---|---|---|
| libkrun | built from source (step 2) | security fixes, a few times a year |
| libkrunfw (guest kernel) | upstream prebuilt | kernel fixes, more often |
| pasta | built from passt.top | occasionally |
| pi (in the VM image) | `PI_VERSION` in `image/Containerfile` | often |
| Fedora base, Chromium, node in the VM | `dnf` when the rootfs is built | weekly security updates |
| Bundled Node | release build | monthly |

How they stay current:

1. **One pin file.** Every version above is pinned in one file (`versions.json`), so a release is
   reproducible and a bump is a small change you can review. `image/Containerfile` and the release
   scripts read it.
2. **A weekly check.** A scheduled GitHub Actions job looks for a new upstream release of each
   pinned piece and, when there is one, opens a pull request against `beta` that bumps the pin.
3. **CI on every bump.** The pull request builds libkrun, the bundle and the rootfs, runs
   `npm test`, and boots one real VM run where the runner has KVM.
4. **Rootfs rebuilt every release,** even with no pin change, so Fedora's security updates reach
   the VMs.
5. **Security fixes skip the wait.** A libkrun, libkrunfw or Chromium security fix goes to `beta`
   and, once its CI passes, straight on to a stable release. Other bumps batch.

### The beta channel

- **`beta` branch:** the newest of everything above. Bump pull requests merge into it automatically
  once CI passes, so it's always the latest, but only CI-tested, not used in real work yet.
- **Beta releases:** every merge to `beta` publishes a signed GitHub prerelease,
  `v<version>-beta.<n>`. `hive update --channel beta` (or `HIVE_UPDATE_CHANNEL=beta`) follows
  them; the default channel follows only full releases. `hive doctor` and Settings › This computer
  show the channel.
- **Promotion:** after a beta has run real tasks for a few days without trouble, merge `beta` into
  `main` and publish a full release from `main`.
- **Rollback:** `hive update --rollback` works the same on both channels; going back to stable is
  `hive update --channel stable`.

## Step 3 — gVisor fallback when there is no KVM

For VPSs without `/dev/kvm`, WSL without nested virtualization, some CI runners and PCs with
virtualization off in the firmware.

- **First, a spike:** rootless `runsc` inside pasta's network namespace (so the agent still
  reaches the internet but not the host or the LAN). The rest of this step depends on that
  combination working; if it doesn't, rethink before building the backend.

- `runsc` is one static Go binary, published upstream, so it's easy to bundle.
- It's a user-space kernel, not a VM, but still a strong boundary.
- It needs a CLI backend that starts pi with the same `work/` and `io/` shares (pi's session lives
  in `io/session`) and the same pasta network isolation. The file-based design (prompt in, event log out, patches back)
  stays the same.
- It needs testing on a machine without KVM.

## Later

- **`hive mcp`:** a stdio MCP server, so Claude Code, pi or other agents can hand tasks to hive.
- **`hive serve`** *(done)*: the HTTP server and web UI, a thin layer over the CLI's run engine
  (`src/web-runs.ts` over `src/runs.ts`), so web runs and `hive run` runs share one engine and one
  run list. `hive service install|status|restart|logs|uninstall` keeps it running as a systemd user
  unit (Linux) or a launchd agent (macOS).
- **macOS:**
  - libkrun on Apple's Hypervisor.framework;
  - a launcher build for Apple silicon (arm64), plus an arm64 rootfs;
  - network isolation without pasta (pasta is Linux-only);
  - code signing with the hypervisor entitlement: an ad-hoc signature (free) is enough to run it on
    your own Mac; a notarized download for other people needs an Apple Developer account (US$99/year).
- **Packages:** `.rpm` and `.deb` for system updates; a signed `.pkg` or Homebrew on macOS.
- **Agent adapters (pi and dsh):** one adapter per harness. Each starts its agent in the VM
  (pi: `pi --mode json`; dsh: `dsh --profile headless --json - < /io/prompt.md`) and turns its
  events into common ones (text, tool started or failed, usage, done) for `render.ts` and the
  cost totals. dsh's `--session-id` makes `hive continue` work for it too. The rootfs ships both.
- **Web search for the agent:** a search key passed like the LLM key (Tavily or Exa free tiers),
  or a keyless fallback; pi supports search through plug-in packages.
- **GUI onboarding:** the first-run screens (welcome, the `hive doctor` checks with a rootfs
  download, adding a model key, GitHub), following the clickable mockup. Design and progress in
  `docs/GUI.md`.
- **Server restarts without stopping runs:** finished runs already survive restarts (they're run
  folders on disk), but a restart stops runs in progress (they're marked "interrupted"). Refuse to
  restart, or wait for them to finish.
- **VM size in Settings:** `HIVE_SANDBOX_MEMORY` and `HIVE_SANDBOX_CPUS` are env settings only;
  an editor under Settings › This computer, maybe a size per run.
- **Split `ui/src/main.ts`** (about 2,200 lines) into modules.
- **`hive serve` front end:** follow opencode's split (the agent as a local server, every UI a
  client over HTTP and server-sent events) and borrow OpenHands' UI patterns (action timeline,
  interrupt button, file-changes view). Notes and licenses in `docs/RESEARCH.md`.

### Workflow improvements

Roughly in order of value (from `docs/RESEARCH.md`):

1. **A cost or time limit per run,** e.g. "stop at $0.50". Token costs are already tracked.
2. **A per-run network allowlist:** the VM can reach only the LLM API and package registries.
3. **Automatic checks:** run the repo's tests in the VM after the agent finishes, and show pass or
   fail in the summary.
4. **The same task on two models side by side,** then pick the better diff.
5. **Notifications** to the desktop or phone when a run finishes.

## Isolation backends considered

When libkrun isn't available there are two different cases:

1. **KVM is there, libkrun isn't packaged** (Mint, Ubuntu, Debian, Ubuntu in WSL). The common case;
   step 2's bundled libkrun covers it completely. It isn't a backend question.
2. **No KVM at all.** Firecracker, Cloud Hypervisor and QEMU need KVM too (QEMU without it emulates
   the CPU and is far too slow for builds), which leaves gVisor or a plain container.

| Option | Needs KVM | Boundary | Bundling | Shared folders | Rootless networking | Platforms | Verdict |
|---|---|---|---|---|---|---|---|
| libkrun | yes (HVF on macOS) | hardware VM, own kernel | build from source | built in (virtiofs) | with pasta | Linux, macOS, WSL2 | main backend |
| gVisor (`runsc`) | no | user-space kernel: the agent's system calls never reach the host kernel directly | one static file | yes (bind mounts) | untested with pasta (step 3 spike) | Linux | fallback without KVM (step 3) |
| Container only (bubblewrap, rootless podman) | no | namespaces only: shares the host kernel, so one kernel bug is an escape | tiny / usually installed | yes | with pasta | Linux | at most an opt-in "reduced isolation" mode, never automatic |
| Firecracker | yes | hardware VM | one static file | no (disk images only) | needs TAP/root | Linux | would need a redesign |
| Cloud Hypervisor | yes | hardware VM | static files | needs virtiofsd | TAP or extras | Linux | more moving parts |
| QEMU | yes (unusably slow without) | hardware VM | large | via virtiofsd | built in | Linux, macOS, Windows | only if Windows without WSL is required |
| Cloud sandboxes (E2B, Modal, …) | — | provider's VMs | — | — | — | any | out of scope: code and key leave the machine, not a local app |

**Container-only mode:** Codex CLI and Claude Code's own sandbox use this model on Linux, and it's
available almost everywhere. But hive's promise is a real VM, so if it's ever added it's opt-in,
and `hive doctor`, the run output and the web UI always say "reduced isolation".

**macOS:** libkrun runs on Apple's Hypervisor.framework (Podman uses it there), so the same backend
carries over with a Mac launcher, an arm64 rootfs and a network setup without pasta. Apple's
`container` tool (one small VM per container on Virtualization.framework) is worth watching as an
alternative. **Windows without WSL** would mean QEMU or Hyper-V; not worth it while WSL exists.

Networking: libkrun's built-in TSI networking gives the guest the host's network as it is, with
nothing blocked. A TAP device needs root plus firewall rules. pasta gives the guest the internet
while blocking the host's loopback, gateway and LAN, with no root. That's why pasta is used.
