# macOS (Apple silicon)

**Status: plan, not implemented.** This is the design for running hive natively on a Mac. Nothing
below is built yet, and the spike in [Phase 0](#phase-0--spike-12-days) decides the networking
piece before the rest is worth starting.

hive runs the agent inside a libkrun microVM. On Linux the VM reaches the internet only through
hive's egress proxy: pasta gives the VMM a network namespace, TSI carries the guest's socket calls
into it, and `-T` forwards exactly one port to the proxy on the host's loopback. macOS has no
pasta and no Linux network namespaces, so that path does not carry over. libkrun itself does: it
runs on Apple's Hypervisor.framework (HVF) on Apple silicon, and the pinned version (1.19.8) has
the macOS virtio-fs and HVF fixes we need.

## Requirements

- **Apple silicon** (arm64) and **macOS 14 or newer**. libkrun's macOS backend is aarch64-only;
  Intel Macs are out of scope.
- **Hardware virtualization available:** `sysctl -n kern.hv_support` prints 1 (it does on an M4).
- **A few GB free** for libkrun's build and the arm64 VM filesystem (the Linux VM filesystem alone
  is about 660 MB).
- For development: Homebrew with `lld` and `xz`, a Rust toolchain with the
  `aarch64-unknown-linux-musl` target, and podman (a `podman machine` runs Linux arm64 natively
  on Apple silicon) to build the guest image.

## What is already true

Verified against libkrun v1.19.8 (the version pinned in `versions.json`) and this Mac (M4,
macOS 27):

- libkrun supports **macOS/ARM64 on HVF**, and the pinned 1.19.8 release includes `vmm/macos` and
  `virtio/fs/macos` fixes, so no version bump is needed for a spike.
- **virtio-fs works on macOS**, which is what `work/`, `io/`, `out/` and the rootfs use.
- **vsock works on macOS.** macOS has no host `AF_VSOCK`, so libkrun keeps a vsock↔UNIX-socket
  proxy for the guest; krunkit uses the same device for its time sync.
- libkrun can run **without TSI**: `krun_disable_implicit_vsock()` then a vsock device with zero
  TSI features, then `krun_add_vsock_port(ctx, port, unixSocketPath)`. TSI is what would give the
  guest the host's network, so disabling it is the whole point.
- `libkrunfw` v5.6.2 publishes `libkrunfw-prebuilt-aarch64.tgz` for macOS (about 20 MB) and
  `libkrunfw-aarch64.tgz` for Linux arm64. Homebrew's `libkrunfw` is the same 5.6.2.
- A macOS launcher must be **ad-hoc codesigned** with `com.apple.security.hypervisor` and
  `com.apple.security.cs.disable-library-validation` (what krunkit's entitlements do). Ad-hoc is
  free and enough on your own Mac; a notarized download for other people needs an Apple Developer
  account (US$99/year).
- Current code assumptions that need a platform branch: `/dev/kvm` (`src/sandbox.ts:28`),
  pasta (`src/pasta.ts`), `/proc` in `recoverRuns` (`src/runs.ts:258`), `du -B1`
  (`src/diskwatch.ts:17`, GNU-only), and the `linux-x86_64` release asset names
  (`src/release.ts:344`).

## Why not pasta or gvproxy

| Backend | Root | What the VM can reach | Verdict |
|---|---|---|---|
| pasta | no | Linux only | not available |
| gvproxy + virtio-net (podman's stack) | no | Its user-mode stack NATs to whatever the host can reach (internet and LAN) and its gateway is a path to host services, so hive's egress proxy stops being the only way out | would break invariants 1 and 13; at most an opt-in "reduced isolation" mode |
| socket_vmnet / vmnet-helper | yes / entitlement | the real LAN | no |
| TSI (libkrun's default) | no | the host's network as-is | no |
| **vsock only (this plan)** | no | one UNIX socket, wired to the egress proxy | **yes** |

A user-mode network stack is not a firewall: any gvproxy-style backend gives the VM a general IP
network, and the agent is root inside the VM, so guest-side rules cannot restore the boundary.
The proxy has to be the only transport, not a policy the guest can route around.

## Design: vsock-only egress

```
guest                                     host
┌────────────────────────────┐            ┌───────────────────────────────────┐
│ pi, npm, chromium          │            │ hive (node)                       │
│   HTTP_PROXY=127.0.0.1:3128            │   egress proxy 127.0.0.1:<port>   │
│        │                   │            │        ▲                          │
│   hive-netd (TCP → vsock)  │            │   per-VM unix-socket bridge       │
│        │ AF_VSOCK, cid 2   │   vsock    │        ▲                          │
│        └───────────────────┼────────────┼── /tmp/hv-XXXX.sock (0600)       │
│  no eth0, no DNS, no IP    │            │  the run folder is not shared     │
└────────────────────────────┘            └───────────────────────────────────┘
```

**Guest.** No virtio-net device at all. `hive-netd`, a small static C helper, listens on
`127.0.0.1:3128` and relays each connection over `AF_VSOCK` to the host (cid 2, the vsock port the
launcher mapped). `hive-vm-init` starts it before the chroot and the usual proxy variables point
at it. DNS is absent by design: the proxy resolves destination names on the host, exactly as it
does today.

**Launcher.** A new `--vsock port:path` mode: `krun_disable_implicit_vsock()`, add a vsock device
with no TSI hijacking, then `krun_add_vsock_port()` for that one port. No port map, no
`--config-net` equivalent. Keep the existing TSI+pasta path for Linux.

**Host.** `runSandbox` starts the shared egress proxy (already does), creates a short
`/tmp/hv-XXXX.sock` (macOS `sun_path` is 104 bytes) and a small server that pipes each connection
to the proxy's loopback port. When the VM exits or the run is stopped, both the socket and the
server go away. The proxy still vets every destination and connects by address, so DNS rebinding
and the no-host/no-LAN rule stay exactly as they are.

What the VM can do: HTTP and HTTPS through the proxy, and nothing else. What it cannot do: open a
TCP connection to any address, resolve a name, reach the host's loopback or the LAN, or send raw
IP. That is stricter than the Linux/pasta setup, where TSI is inside a namespace that pasta
configures.

**Later, optionally:** the same mechanism works on Linux (`krun_add_vsock_port` is not
macOS-specific). Once macOS proves it, Linux could drop pasta and use one network model everywhere.
That is deliberately *not* part of this step; Linux stays untouched until macOS ships.

## Filesystems: case and ownership

macOS volumes are **case-insensitive** by default (APFS: `File.txt` and `file.txt` are one file),
and an ordinary Mac user cannot create files owned by root, device nodes or other users' files.
On Linux both the VM's root and a run's `work/` are plain host folders shared over virtio-fs, so
neither problem exists there. On a Mac it would bite in two places:

- **The VM filesystem.** Unpacking the Fedora rootfs into a folder collides on paths that differ
  only by case (they exist in a normal Fedora install, for example under `/usr/share/terminfo` and
  in Perl and kernel-header trees) and loses root ownership, setuid bits and device nodes.
  **Plan: ship the macOS rootfs as a read-only disk image** (erofs, or ext4) attached with
  virtio-blk (`BLK=1`, already in the Phase 0 build), not as a folder. The image keeps Linux
  semantics inside the VM whatever the Mac's disk does, and it is one file to download, verify
  and replace. The RAM overlay for writes stays as it is.
- **The run's `work/`.** A repo with two paths that differ only by case cannot be checked out
  correctly on a case-insensitive folder, and git in the VM would see phantom changes.
  **Plan:** keep the run folders on a case-sensitive APFS volume or disk image that hive creates
  once (`hdiutil create -fs "Case-sensitive APFS"`, mounted under hive's data dir), or at minimum
  detect case collisions when cloning and refuse the run with a clear message. Decide in Phase 0
  from the numbers: a case-sensitive sparse image also shares over virtio-fs, so it doesn't change
  the design.

Ownership inside `work/` is not a problem: the agent runs as root in the VM and files map to the
Mac user on the host, as they do with rootless podman on Linux.

## Phases

### Phase 0 — Spike (1–2 days)

Goal: answer the four unknowns on real hardware before touching hive.

1. Build the pinned libkrun:
   ```bash
   brew install lld xz libkrunfw
   rustup target add aarch64-unknown-linux-musl
   git clone https://github.com/libkrun/libkrun && cd libkrun
   git checkout v1.19.8
   make BLK=1 NET=1
   make BLK=1 NET=1 PREFIX="$HOME/.local" install
   ```
2. With podman (arm64 machine), export a small Fedora arm64 rootfs. A bare rootfs is enough for
   the transport tests; the full hive image comes in Phase 2.
3. Write a throwaway C launcher (~80 lines) that does: disable implicit vsock → add a TSI-free
   vsock device → map port 1024 to `/tmp/echo.sock` → share the rootfs and one test folder →
   `krun_set_exec` a shell.
4. Check, in this order:
   - the VM boots on HVF (record the time);
   - the shared folder is visible and `git status` / a small `npm install` on it is usable
     (virtio-fs is the performance risk);
   - guest `AF_VSOCK` to cid 2 port 1024 reaches a host UNIX socket and bytes come back (use
     `socat VSOCK-CONNECT:2:1024` in the guest for the spike);
   - `curl -x http://127.0.0.1:3128 https://example.com` works through hive's existing egress
     proxy, with a tiny TCP→vsock forwarder in front of it.
5. Negative test, the security gate: with TSI disabled, `curl --noproxy '*'` to a LAN address,
   a public IP and a hostname, plus `ping`, must all fail.
6. Ad-hoc sign the test launcher with krunkit's entitlements and confirm it still boots.
7. Filesystems (see [Filesystems](#filesystems-case-and-ownership)): boot from the rootfs as a
   read-only erofs/ext4 image over virtio-blk and check that root-owned files, setuid `sudo` and
   case-differing paths are intact; then clone a repo with two paths that differ only by case into
   a case-sensitive APFS sparse image shared over virtio-fs, and confirm `git status` is clean.

**Exit criteria:** a booting macOS VM with proxy-only networking, and numbers for boot time,
virtio-fs throughput and vsock throughput. If step 4 or 5 fails, stop: the fallback is gvproxy with
an explicit "reduced isolation" label, and that is a product decision, not an implementation detail.

### Phase 1 — Networking in the launcher and host (2–4 days)

- `vm/hive-vm.c`: `__APPLE__` guards — HVF check instead of `/dev/kvm`, `libkrun.1.dylib` as the
  default `dlopen` name, macOS-safe compile flags (`-Wl,-z,relro,-z,now` is ELF-only), the
  `--vsock` mode above, `--pidfile`, and `--watch-pid` (it works on macOS: there is no pasta PID
  namespace, so a dead hive stops its VM immediately).
- `src/sandbox.ts`: spawn `hive-vm` directly on macOS (no pasta), start the per-VM bridge, point
  `HTTP(S)_PROXY` at `http://127.0.0.1:3128`, and clean both up on exit, abort, stall and timeout.
- `image/`: `hive-netd` plus its start-up in `hive-vm-init`; `no-ipv6` stays for Linux but is
  irrelevant on this path (its seccomp filter is x86_64-only and inert on arm64).
- `src/pasta.ts`, `src/libkrun.ts`: pick the network backend by platform (`vsock` / `pasta`),
  dylib candidates (`lib/libkrun.1.dylib`, `libkrunfw.5.dylib`) and the labels `hive doctor` and
  the UI show.

**Exit criteria:** `hive run` on this Mac completes a real task, and the Phase 0 negative network
tests still hold inside a hive run.

### Phase 2 — arm64 rootfs (1–2 days)

- Build `image/` for `linux/arm64` (a `podman machine` or an `ubuntu-24.04-arm` CI job) and check
  Chromium, Node 24, pi and `hive-export` on arm64.
- Make `vm/build-rootfs.sh` architecture-aware; name the artifact
  `hive-rootfs-<hash>-linux-arm64.tar.gz`.
- Keep the license/source obligations current (Fedora, Chromium, node, pi; libkrunfw is already in
  `THIRD-PARTY.md`).

### Phase 3 — Hive platform plumbing (3–5 days)

- **First, make `npm test` green on macOS.** Today 17 tests fail on this machine for four reasons:
  `vm/hive-vm` is not built (skip instead of fail), `du -B1` (use `-k`), `/private/var` vs
  `/var` in one test, and `rmSync` on a symlink to a directory (`ERR_FS_EISDIR`; use
  `unlinkSync`). A red suite hides every macOS regression.
- `src/config.ts`: default network mode per platform; accept `HIVE_RUNTIME=auto` (the CLI
  currently rejects the documented default, `src/cli.ts:1743`).
- `src/sandbox.ts` `libkrunAvailable()`/`systemInfo()`: HVF check, no pasta requirement, macOS
  check names and fixes.
- `src/runs.ts`: `recoverRuns` via the pidfile plus `ps -axo pid=,command=` on macOS; keep
  `/proc` on Linux.
- `src/diskwatch.ts`: `du -s -k -x --`, then ×1024 (works on both platforms and fixes the 512×
  undercount). `src/stall.ts` is fine as is (`find -mmin` is portable).
- `src/usage.ts`: no `/proc` or `/sys` on macOS — `os.freemem` fallback, no temperature sensor.
- `src/service.ts`: launchd already exists; fix the release-bundle command (it currently points at
  `lib/cli.js`, which a bundle does not ship).
- `src/release.ts`: platform/arch asset names (`darwin-arm64` app, `linux-arm64` rootfs) and
  install paths.
- `install-cli.sh` (or a macOS installer): `shasum -a 256` fallback, zsh `PATH`, Gatekeeper note.
- UI: "This computer" shows Hypervisor.framework and the vsock network; nothing else changes.

### Phase 4 — Release and distribution (2–4 days)

- `scripts/build-native-macos.sh`: libkrun 1.19.8 from source, `libkrunfw-prebuilt-aarch64`,
  the launcher with entitlements and an ad-hoc signature, `install_name_tool` so the bundled
  libkrun finds libkrunfw next to it, then re-sign.
- `scripts/build-release-macos.sh`: Node `darwin-arm64`, the esbuild bundle, `ui/dist`, the arm64
  rootfs, `SHA256SUMS` and the release signature; wire it into the dev/release workflows on
  `macos-14`.
- `versions.json`: add `libkrunfw.macos.aarch64` and `libkrunfw.linux.aarch64` URLs with
  SHA-256; teach `scripts/check-updates.mjs` about them.
- Docs: a macOS section in `docs/INSTALL.md`, the README requirements, `AGENTS.md`, and the
  roadmap.
- Later: Homebrew tap or cask; a notarized Developer ID build for distribution.

**Total: roughly 2–4 weeks** after the spike. The security/networking work (Phases 0–1) carries
almost all of the risk; Phases 2–4 are mostly packaging.

## Changes by file

| File | Change |
|---|---|
| `vm/hive-vm.c` | HVF/dylib guards, vsock-only network mode, pidfile, macOS flags |
| `image/hive-vm-init` | start `hive-netd`; nothing else |
| `image/hive-netd.c` (new) | TCP `127.0.0.1:3128` → `AF_VSOCK` cid 2 |
| `image/Containerfile` | build and install `hive-netd` for the guest architecture |
| `src/sandbox.ts` | macOS spawn path, unix-socket bridge, HVF check, labels |
| `src/pasta.ts`, `src/libkrun.ts` | backend/dylib selection per platform |
| `src/runs.ts` | `recoverRuns` without `/proc`; launcher pid |
| `src/diskwatch.ts` | portable `du` |
| `src/config.ts`, `src/usage.ts`, `src/service.ts`, `src/release.ts` | platform branches |
| `src/cli.ts` | doctor/checks, `HIVE_RUNTIME` validation |
| `install-cli.sh` / `install.sh` | macOS install and `update` path |
| `scripts/build-native-macos.sh`, `scripts/build-release-macos.sh` (new) | build and sign |
| `versions.json`, `scripts/check-updates.mjs` | arm64 pins |
| `.github/workflows/` | macOS unit/build job; arm64 rootfs; release assets |

## Risks

| Risk | Mitigation |
|---|---|
| Case-insensitive APFS and no root ownership break a folder-based rootfs and repos with case-colliding paths | rootfs as a read-only disk image over virtio-blk; run folders on a case-sensitive APFS image, or refuse case collisions; tested in Phase 0 step 7 |
| virtio-fs is slow for many small files (git, npm) on macOS | measure in Phase 0; if unusable, put `work/` on a virtio-blk image and export patches — a bigger change, decided on numbers |
| vsock-without-TSI does not behave as documented | the Phase 0 negative test is the gate; fallback is gvproxy with an explicit reduced-isolation label |
| Chromium, npm or git ignores the proxy and wants DNS | all honour the `*_PROXY` variables today; test each in Phase 0; npm's cache already lives in the VM |
| GitHub's macOS runners are VMs, and nested HVF needs an M3+ host and macOS 15+ | do not count on a VM boot in CI: unit tests and `hive-vm --check` there, a `scripts/macos-smoke.sh` run by hand on real hardware |
| UNIX socket path longer than 104 bytes | short `/tmp/hv-XXXX.sock`; the ctl dir stays under the run folder |
| macOS sleep and the run time limit (`CLOCK_MONOTONIC` excludes sleep) | decide whether the limit is wall-clock or awake time; use a continuous clock if wall-clock |
| Signing and notarization | ad-hoc for local use; Developer ID + notarization only when distributing |

## Open decisions

1. **Apple silicon only (macOS 14+)** — Intel Macs are out. Accepted?
2. **Proxy-only egress by default**, with gvproxy only as an explicit reduced-isolation opt-in.
3. **Source build first**, signed/notarized installer later.
4. **arm64 rootfs in CI** (`ubuntu-24.04-arm`) or a local `podman machine`.
5. **Linux stays on pasta** until macOS ships; unify later.

## Sources

- [libkrun](https://github.com/libkrun/libkrun): HVF on macOS/ARM64, TSI vs `virtio-net`, and the
  device list.
- [libkrun networking](https://github.com/libkrun/libkrun/blob/main/docs/networking.md): TSI,
  `virtio-net`, and what each one can reach.
- [libkrun building on macOS](https://github.com/libkrun/libkrun/blob/main/docs/building.md):
  macOS 14+, `lld`, the musl guest-init target.
- [krunkit](https://github.com/libkrun/krunkit): the reference macOS libkrun launcher; its
  [usage](https://github.com/libkrun/krunkit/blob/main/docs/usage.md) documents virtio-fs and the
  vsock↔UNIX-socket proxy, and its
  [entitlements](https://github.com/libkrun/krunkit/blob/main/krunkit.entitlements) are the two
  keys a macOS launcher needs.
- [gvisor-tap-vsock (gvproxy)](https://github.com/containers/gvisor-tap-vsock): the podman network
  stack, and why it is not a substitute for the egress proxy.
- [libkrunfw v5.6.2](https://github.com/libkrun/libkrunfw/releases/tag/v5.6.2): the
  `prebuilt-aarch64` (macOS) and `aarch64` (Linux) assets.
