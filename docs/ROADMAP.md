# Roadmap

Decisions and next steps for the `hive` CLI. Each step ships on its own, tested on a real machine,
on one branch (`main`).

## Step 1 — Releases, `hive update`, system libkrun *(code done; first release not published)*

Built and tested (`test/release.test.mjs`). To ship: generate the signing key, paste its public key
into `src/release-key.ts`, then publish the first release as `docs/RELEASING.md` describes.

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
  fixes, and the download grows by about 30 MB.

## Step 3 — gVisor fallback when there is no KVM

For VPSs without `/dev/kvm`, and WSL without nested virtualization.

- `runsc` is one static Go binary, published upstream, so it's easy to bundle.
- It's a user-space kernel, not a VM, but still a strong boundary.
- It needs a CLI backend that starts pi with the same `work/`, `io/` and `session/` shares and
  the same pasta network isolation. The file-based design (prompt in, event log out, patches back)
  stays the same.
- It needs testing on a machine without KVM.

## Later

- **`hive continue [run] "<prompt>"`:** a follow-up on the same run. It boots a fresh VM on the
  same `work/` and pi `session/`, so the agent remembers what it did. The old server did follow-ups
  this way.
- **`hive mcp`:** a stdio MCP server, so Claude Code, pi or other agents can hand tasks to hive.
- **`hive serve`:** the HTTP server and web UI on top of the CLI core, for phone and remote use.
- **macOS:**
  - libkrun on Apple's Hypervisor.framework;
  - a launcher build for Apple silicon (arm64), plus an arm64 rootfs;
  - network isolation without pasta (pasta is Linux-only);
  - code signing with the hypervisor entitlement (needs an Apple Developer account).
- **Packages:** `.rpm` and `.deb` for system updates; a signed `.pkg` or Homebrew on macOS.
- **Stall detection:** stop a run when the agent stops making progress, not only at
  `HIVE_SANDBOX_TIMEOUT_MIN`. Signal: no file in `work/` changed for N minutes (default 15,
  configurable). Event gaps alone aren't enough, since a model can think for minutes before
  writing. dsh-vm does this already (`DSH_VM_STALL_MIN`).
- **Agent adapters (pi and dsh):** one adapter per harness. Each starts its agent in the VM
  (pi: `pi --mode json`; dsh: `dsh --profile headless --json - < /io/prompt.md`) and turns its
  events into common ones (text, tool started or failed, usage, done) for `render.ts` and the
  cost totals. dsh's `--session-id` makes `hive continue` work for it too. The rootfs ships both.
- **Web search for the agent:** a search key passed like the LLM key (Tavily or Exa free tiers),
  or a keyless fallback; pi supports search through plug-in packages.
- **GUI with onboarding:** the web UI's new design, Runs and Settings (API keys read-only, This
  computer) are built. Still to do: first run (welcome, the `hive doctor` checks with a rootfs
  download, adding a model key) and key management, following the clickable mockup. Design and
  progress in `docs/GUI.md`.
- **Server restarts without losing runs:** refuse to restart, or let running tasks finish, and keep
  finished runs across restarts.
- **Windows:** via WSL2 with nested virtualization (needs step 2's bundled libkrun), or gVisor
  from step 3 where there's no KVM.
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
6. **Per-repo caches** for faster starts, extending the npm cache to pip and others.

## Isolation backends considered

| Option | Bundling | Shared folders | Rootless networking | Platforms | Verdict |
|---|---|---|---|---|---|
| libkrun | build from source | built in (virtiofs) | with pasta | Linux, macOS, WSL2 | main backend |
| gVisor (`runsc`) | one static file | yes | yes | Linux, no KVM needed | fallback (step 3) |
| Firecracker | one static file | no (disk images only) | needs TAP/root | Linux | would need a redesign |
| Cloud Hypervisor | static files | needs virtiofsd | TAP or extras | Linux | more moving parts |
| QEMU | large | via virtiofsd | built in | Linux, macOS, Windows | only if Windows without WSL is required |

Networking: libkrun's built-in TSI networking gives the guest the host's network as it is, with
nothing blocked. A TAP device needs root plus firewall rules. pasta gives the guest the internet
while blocking the host's loopback, gateway and LAN, with no root. That's why pasta is used.
