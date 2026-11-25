# macOS (Apple silicon)

> The VM filesystem changed base on 2026-11-24: it is Debian 13 (trixie) instead of Fedora, from
> the same `image/Containerfile`. Everything below that describes Fedora is the history of what was
> tried and measured on the earlier base; the mechanics (case-insensitive APFS, ownership, device
> nodes) still apply.

**Status: Phases 0–2 are done (November 2026); Phase 3 has a green macOS test suite, while the
run image and `/proc`-free recovery are still open. Phase 4's native build, release bundle,
installer and CI build are in place; the signed public macOS release is the remaining distribution
step.** On an M4, hive's own launcher boots a read-only ext4 image with the implicit vsock disabled
and one vsock port wired to hive's egress proxy, and a real `runSandbox` run passes the negative
network tests (`npm run smoke:macos`). The CI-built arm64 Fedora image boots the same way,
`hive setup` installs it as a `.img.gz`, and a locally built `hive-<version>-darwin-arm64`
bundle reports every check as ok and can run a VM. See [Phase 0 results](#phase-0-results),
[Phase 1 results](#phase-1-results), [Phase 4 results](#phase-4-results) and
[`scripts/macos-spike/`](../scripts/macos-spike/README.md).

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
- For the native build: Xcode command line tools (clang and libclang), Rust stable, make, git,
  curl and network. The build uses Rust's `rust-lld`, so Homebrew's `lld` is not needed.
- To build the guest image locally: an arm64 Linux host, or a `podman machine` (it runs Linux
  arm64 natively on Apple silicon); macOS has no `mkfs`. The `macos-image` workflow does this
  on `ubuntu-24.04-arm` and uploads the result.

## What is already true

Verified against libkrun v1.19.8 (the version pinned in `versions.json`) and this Mac (M4,
macOS 27):

- libkrun supports **macOS/ARM64 on HVF**, and the pinned 1.19.8 release includes `vmm/macos` and
  `virtio/fs/macos` fixes, so no version bump is needed for a spike.
- **virtio-fs works on macOS**, which is what `work/`, `io/` and `out/` use.
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
- libkrunfw's aarch64 kernel has `EXT4_FS`, `EROFS_FS`, `SQUASHFS` and `VIRTIO_BLK` built in,
  and libkrun 1.19.8 has `krun_add_disk(..., read_only)`, so a read-only rootfs image is supported.
- Phase 1 added the platform branches for `/dev/kvm` versus `kern.hv_support`, pasta versus
  vsock, the dylib name and the VM image. Phase 2 added the arm64 image and its install path;
  Phase 3 has made `npm test` green on macOS and `du` portable. Phase 4 added
  `scripts/build-native-macos.sh`, `scripts/build-release-macos.sh`, the macOS branch of
  `install-cli.sh` and the dispatchable `macos-release` workflow. Still open: `/proc` in
  `recoverRuns` (`src/runs.ts:258`), the run-image lifecycle, and publishing/notarizing a
  signed macOS release.

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

## Filesystems: case, ownership and the rootfs image

macOS volumes are **case-insensitive** by default (APFS: `File.txt` and `file.txt` are one file),
and an ordinary Mac user cannot create files owned by root, device nodes or files with file
capabilities. Linux has neither problem, so both only show up on a Mac. They hit in two separate
places, and each has its own fix.

### The guest rootfs: a raw image, not a folder

Unpacking the Fedora rootfs into a folder collides on paths that differ only by case: a normal
Fedora install has them, for example under `/usr/share/terminfo` (`a/` and `A/`) and in Perl and
kernel-header trees. A folder also loses root ownership, setuid bits, device nodes and file
capabilities, and exposes the whole rootfs (tens of thousands of files) through virtio-fs.

**Plan: ship the macOS rootfs as a raw disk image attached read-only with virtio-blk.** The image
keeps Linux semantics inside the VM whatever the Mac's disk does, and it is one file to download,
verify and replace. The RAM overlay for writes stays as it is.

- **Format:** libkrunfw's aarch64 kernel has `EXT4_FS`, `EROFS_FS` and `SQUASHFS` built in, plus
  `VIRTIO_BLK`, so all three work. Pick on size and boot time: erofs and squashfs compress better,
  ext4 is the most familiar. Decide in Phase 0.
- **Read-only means enforced on the host:** `krun_add_disk(ctx, "root", path, read_only = true)`
  and the host opens the file read-only. `mount -o ro` in the guest is not enough, because the
  guest's root could remount it. Confirm the exact root-disk call in Phase 0; 1.19.8 still has the
  deprecated `krun_set_root_disk` for comparison.
- **Consequences for the code:** `hive-vm --rootfs` takes a file, `libkrunAvailable()` checks a
  file, libkrun boots the image as the read-only root device and `hive-vm-init` only builds the
  overlay on top, and the release asset becomes `hive-rootfs-<hash>-linux-arm64.img` (or
  `.img.gz`) instead of a folder tarball. Linux can keep the folder rootfs until the image path
  has proved itself.

### Run folders: case-sensitive by default, not as a fallback

A repo with two paths that differ only by case cannot be checked out on a case-insensitive folder.
This bites **before** `work/` exists: `prepareRepo` clones the pristine copy into `<run>/origin`
on the same volume, and `origin/` is what pushes and exports read, so detecting a collision after
that clone is already too late.

**Plan: keep the run folders on a case-sensitive APFS sparse image that hive creates once**
(`hdiutil create -fs "Case-sensitive APFS" -type SPARSE`, stored under the data dir and attached at
a fixed mountpoint). That covers `origin/`, `work/`, `io/`, `out/` and every run, so a
case-colliding repo simply works and no detection is needed. Share it over virtio-fs as usual.

Its lifecycle needs as much care as the proxy:

- **Attach at startup** (CLI, `hive serve`, the launchd service) and **detach on shutdown**;
  `hive uninstall` must detach it too.
- **Keep a marker file inside the image and refuse to run when it is not mounted.** Otherwise the
  mountpoint is an empty folder: runs "disappear", and new ones land on the Mac volume.
- **Measure disk use on the host.** `statfsSync(runsDir)` inside the image reports the image's
  filesystem, not the Mac's free space, and `du` on the mount does not show the sparse file's
  allocation. The free-space guard (`HIVE_MIN_FREE_DISK_GB`) must look at the volume holding the
  image, and the image needs a size cap and a growth policy.

Ownership inside `work/` is not a problem: the agent runs as root in the VM and files map to the
Mac user on the host, as they do with rootless podman on Linux.

## Phases

### Phase 0 — Spike (2–3 days)

Goal: answer the unknowns that decide the design, on real hardware, before touching hive.

1. Build the pinned libkrun:
   ```bash
   brew install lld xz libkrunfw
   rustup target add aarch64-unknown-linux-musl
   git clone https://github.com/libkrun/libkrun && cd libkrun
   git checkout v1.19.8
   make BLK=1 NET=1
   make BLK=1 NET=1 PREFIX="$HOME/.local" install
   ```
2. With podman (arm64 machine), export a Fedora arm64 rootfs and turn it into a raw image
   (`mke2fs -d` for ext4, or `mkfs.erofs`). Do not extract it to a folder: the Fedora tree has
   case collisions on APFS (terminfo `a/` and `A/`), so a folder rootfs is subtly wrong from the
   start. A minimal image is enough for the transport tests; the full hive image comes in Phase 2.
3. Write a throwaway C launcher (~80 lines) that does: disable implicit vsock → add a TSI-free
   vsock device → map port 1024 to `/tmp/echo.sock` → attach the rootfs image read-only with
   virtio-blk → share one test folder → `krun_set_exec` a shell.
4. Check, in this order:
   - the VM boots on HVF from the image (record the time);
   - the shared folder is visible and `git status` / a small `npm install` on it is usable
     (virtio-fs is the performance risk);
   - guest `AF_VSOCK` to cid 2 port 1024 reaches a host UNIX socket and bytes come back (use
     `socat VSOCK-CONNECT:2:1024` in the guest for the spike);
   - `curl -x http://127.0.0.1:3128 https://example.com` works through hive's existing egress
     proxy, with a tiny TCP→vsock forwarder in front of it.
5. Negative test, the security gate: with TSI disabled, `curl --noproxy '*'` to a LAN address,
   a public IP and a hostname, plus `ping`, must all fail.
6. Ad-hoc sign the test launcher with krunkit's entitlements and confirm it still boots.
7. Filesystems (see [Filesystems](#filesystems-case-ownership-and-the-rootfs-image)): boot from
   the raw image with virtio-blk, confirm the guest cannot remount it writable, that the terminfo
   `a/` and `A/` trees both survive and that file capabilities are present; then clone a repo with
   two paths that differ only by case into a case-sensitive APFS sparse image shared over
   virtio-fs, and confirm `git status` is clean.

### Phase 0 results

Run on an Apple M4 (macOS 27.0.1, build 26A434, arm64, `sysctl -n kern.hv_support` = 1), Apple
clang 21.0.0 and Rust 1.99.1, with no podman/docker/lima and no Homebrew writes. Reproducer:
[`scripts/macos-spike/`](../scripts/macos-spike/README.md).

**Verdict: the Phase 0 gate passed.** A libkrun 1.19.8 VM booted from a raw ext4 image attached
read-only with virtio-blk, with the implicit vsock disabled (`krun_add_vsock(ctx, 0)`) and one
vsock port mapped to a host UNIX socket. Hive's unmodified egress proxy answered HTTP and HTTPS
through that socket, and every direct network attempt failed. Phase 1 has since built on this
result (see [Phase 1 results](#phase-1-results)).

| What | Result |
|---|---|
| libkrun | v1.19.8, commit `c4d283c`, `BLK=1 NET=1`; `libkrun.1.19.8.dylib` 5.4 MiB, SHA-256 `c20c89af…f0b353095` |
| libkrunfw | 5.6.2, prebuilt aarch64 tarball SHA-256 `adef6739…0e7984e86`; `libkrunfw.5.dylib` 24 MiB, SHA-256 `12b2d22c…fd1bb41e6` |
| Rootfs image | Alpine 3.22.8 aarch64, ext4, 1.5 GiB nominal / 104 MiB allocated / 39 MiB gzip; SHA-256 `abb3ab05…acb0529c6` |
| Boot time (5 runs) | guest `/proc/uptime` median **0.070 s** (0.05–0.07 s); host wall median **0.128 s** (0.113–0.138 s), including two virtio-fs shares and the vsock device |
| virtio-fs on `work/` | 256 MiB write **0.144–0.170 s (1.5–1.7 GiB/s)**; read **0.066–0.070 s (3.6–3.8 GiB/s, page-cache warm)**; 2000 small files **0.410–0.500 s (~4,000–4,900 files/s)**; small npm install **0.180 s** |
| vsock | 128 MiB to the host in **0.130–0.160 s**, **842–955 MiB/s** (three runs) |

**Checklist**

1. **Boot from the raw image over virtio-blk.** Pass. The launcher uses
   `krun_add_disk(ctx, "root", image, true)` and
   `krun_set_root_disk_remount(ctx, "/dev/vda", "ext4", "ro")`. The guest sees
   `/dev/vda / ext4 ro,relatime`; `touch /rotest` fails with "Read-only file system", and
   `mount -o remount,rw /` fails with EACCES. The `"ro"` option is required: without it the guest
   tries an rw mount on the read-only block device and fails at boot.
2. **Shared folders.** Pass. virtio-fs shares are visible and usable; the case-sensitive APFS
   share held a git checkout with `a.txt` and `A.txt`, `git status` was clean, and a clone into
   the guest's tmpfs kept both paths. The throughput numbers above are the virtio-fs answer.
3. **AF_VSOCK to cid 2, port 1024.** Pass. `printf 'hello-vsock\n' | socat - VSOCK-CONNECT:2:1024`
   returned `hello-vsock` from a host UNIX-socket echo server; 128 MiB one-way measured
   842–955 MiB/s.
4. **`curl` through hive's egress proxy.** Pass. `scripts/macos-spike/host-bridge.mjs` starts
   `startEgressProxy()` from `dist/egress.js`, listens on a short `/tmp/hv-*.sock` (0600) and pipes
   each accepted connection to the proxy's loopback port. In the guest,
   `socat TCP-LISTEN:3128,bind=127.0.0.1,fork VSOCK-CONNECT:2:1024` is the forwarder. HTTP and
   HTTPS to `example.com` both returned 200; the proxy returned 403 for `192.168.1.1` and
   `169.254.169.254`, logging both denials on the host.
5. **Negative test, the security gate.** Pass. With `--vsock` (implicit vsock disabled and
   `krun_add_vsock(ctx, 0)`), the kernel command line has no `tsi_hijack`, the guest has no
   `eth0`, and only `lo` plus a down `dummy0` exist. `curl --noproxy '*'` to the LAN
   (192.168.1.1:80) and to a public IP (1.1.1.1:80) fails with "Could not connect"; a hostname
   (example.com) fails with "Could not resolve host"; `ping 1.1.1.1` fails with
   "Network unreachable".
6. **Ad-hoc signing.** Pass. The launcher is signed `codesign --force --sign -` with
   `com.apple.security.hypervisor` and `com.apple.security.cs.disable-library-validation`; it
   boots and loads the locally built dylibs.
7. **Filesystems.** Pass with one deviation. A raw ext4 image keeps `a.txt` and `A.txt` as
   distinct files; `getcap /bin/busybox` shows `cap_net_raw=p` after setting
   `security.capability` with `debugfs ea_set` on an image copy; the root cannot be remounted
   rw. The Fedora terminfo `a/`/`A/` pair was not available (see below), so the equivalent
   case-colliding pair was tested in the image and on the case-sensitive APFS share.

**Deviations, decisions and things Phase 1 must know**

- **The test image is Alpine, not Fedora.** No podman/docker/lima is available on this Mac, so the
  Fedora arm64 rootfs could not be exported locally. The image was built in two libkrun boots (the
  first with TSI, for `apk add`; the second running `mke2fs -d` inside the guest). A minimal image
  is enough for the transport tests; the full Fedora image remains Phase 2 and belongs on an
  `ubuntu-24.04-arm` runner.
- **ext4 is the format Phase 0 chose.** It keeps file capabilities, `mke2fs -d` works without a
  Linux host, and the 1.5 GiB image is 104 MiB allocated / 39 MiB gzipped. erofs/squashfs were not
  compared; if Phase 2 wants a smaller download, revisit them there.
- **`krun_set_root_disk_remount` needs the `"ro"` option**, not just the read-only virtio-blk
  device. Without it the ext4 rw mount is refused with EACCES.
- **Never pass `NULL` as `krun_set_exec`'s envp.** libkrun then puts the host's entire
  environment on the kernel command line and the VM fails with a `TooLarge` panic. Pass a minimal
  env (`PATH`, `HOME`, `TERM`, plus what the run needs).
- **macOS 27's `hdiutil create -type SPARSE` fails** with "Directory not empty"; the new
  `diskutil image create` (ASIF) works, and `newfs_apfs -o case=sensitive` on a temporary RAM disk
  proved case-sensitive APFS over virtio-fs. The persistent run-image lifecycle (ASIF image +
  APFSX volume, `diskutil apfs createContainer`/`addVolume`, attach/detach) is Phase 3 work and
  needs raw-device permission; it was not validated end to end.
- **The libkrunfw "prebuilt" tarball contains `kernel.c` and a Makefile, not a prebuilt dylib.**
  Building `libkrunfw.5.dylib` is one `cc -shared` step, which is fine.
- **bindgen's build scripts need an rpath workaround.** A symlink at
  `libkrun/target/release/libclang.dylib` is enough; setting `LIBCLANG_PATH` only is not, and
  `DYLD_FALLBACK_LIBRARY_PATH` is stripped by this environment.
- **A read-only rootfs has a read-only `/tmp`.** The guest init mounts `/dev/shm` as tmpfs, so
  the spike's forwarder logs and downloads go there. `hive-vm-init` should mount a tmpfs on
  `/tmp` (or tools must use `/dev/shm`) in Phase 1.
- **The guest sees a down `dummy0`** even with TSI off. It has no route and is not a network
  path; the negative tests pass.
- **The first attempt's constraints all held.** `rust-lld` symlinked as `ld.lld`, a workspace
  `CARGO_HOME`, `CC_LINUX` pointing at the downloaded Debian sysroot, and `LIBCLANG_PATH` plus
  the `target/release/libclang.dylib` symlink were exactly what the build needed. One correction
  to those notes: the libkrunfw "prebuilt" tarball contains `kernel.c`, not a dylib (see above).

**Exit criteria:** a booting macOS VM with proxy-only networking, and numbers for boot time,
virtio-fs throughput on `work/`, vsock throughput and the image size. If step 4 or 5 fails, stop:
the fallback is gvproxy with an explicit "reduced isolation" label, and that is a product decision,
not an implementation detail.

### Phase 1 — Networking in the launcher and host (2–4 days)

- `vm/hive-vm.c`: `__APPLE__` guards — HVF check instead of `/dev/kvm`, `libkrun.1.dylib` as the
  default `dlopen` name, macOS-safe compile flags (`-Wl,-z,relro,-z,now` is ELF-only), the
  `--vsock` mode above, `--pidfile`, and `--watch-pid` (it works on macOS: there is no pasta PID
  namespace, so a dead hive stops its VM immediately). Also `--rootfs` taking a raw image that is
  attached read-only with `krun_add_disk`, instead of a folder.
- `src/sandbox.ts`: spawn `hive-vm` directly on macOS (no pasta), start the per-VM bridge, point
  `HTTP(S)_PROXY` at `http://127.0.0.1:3128`, and clean both up on exit, abort, stall and timeout.
- `image/`: `hive-netd` plus its start-up in `hive-vm-init`; `no-ipv6` stays for Linux but is
  irrelevant on this path (its seccomp filter is x86_64-only and inert on arm64).
- `src/pasta.ts`, `src/libkrun.ts`: pick the network backend by platform (`vsock` / `pasta`),
  dylib candidates (`lib/libkrun.1.dylib`, `libkrunfw.5.dylib`) and the labels `hive doctor` and
  the UI show.

**Exit criteria:** `hive run` on this Mac completes a real task from the read-only rootfs image,
and the Phase 0 negative network tests still hold inside a hive run.

### Phase 1 results

Verified on the same M4 (macOS 27.0.1, build 26A434) with the Phase 0 Alpine image, extended with
`hive-vm-init` and `hive-netd`. The arm64 Fedora image is Phase 2, so `hive run` itself has not run
end to end yet; everything else is the product path. `runSandbox()` from `dist/sandbox.js` started
`startEgressProxy()` → the vsock bridge → `vm/hive-vm --vsock 1024:/tmp/hv-….sock` →
`hive-vm-init` → `hive-netd` → `curl -x http://127.0.0.1:3128`.

| Check | Result |
|---|---|
| Boot | TSI off (`/proc/cmdline` has no `tsi_hijack`); only `lo` and a down `dummy0`; `/` is the ext4 image from `/dev/vda`, attached read-only |
| Launcher | `kern.hv_support` = 1; ad-hoc signed with `com.apple.security.hypervisor` and `com.apple.security.cs.disable-library-validation` |
| vsock | port 1024 → the host socket; `hive-netd` listens on 127.0.0.1:3128 inside the VM |
| proxy | HTTP and HTTPS `example.com` → 200; `192.168.1.1` and `169.254.169.254` → 403 |
| direct | LAN, public IP, hostname and ping all fail ("Could not connect", "Could not resolve host", "Network unreachable") |
| cleanup | the bridge socket and the launcher's pidfile are gone when the VM exits |

**What changed**

- `vm/hive-vm.c`: `__APPLE__` guards for the virtualization check (`kern.hv_support` instead of
  `/dev/kvm`) and the default dylib name (`libkrun.1.dylib`); `--rootfs` accepts a raw disk image,
  attached read-only with `krun_add_disk` and mounted `ro` through `krun_set_root_disk_remount`;
  `--vsock PORT:SOCKET` disables the implicit vsock, adds a TSI-free device and maps the port;
  `--pidfile`; no port map on macOS. On macOS the launcher refuses a folder rootfs and refuses to
  boot without `--vsock`, so the TSI path cannot be reached by accident.
- `image/hive-netd.c` (new) and `image/hive-vm-init`: the guest listens on 127.0.0.1:3128 and
  relays each connection over vsock; the launcher passes `HIVE_VSOCK_PORT`, and the init starts
  netd only when it is set. `image/Containerfile` builds it static (`glibc-static`).
- `src/vsock.ts` (new): a short `/tmp/hv-….sock` (0600) and a server that pipes each connection to
  the egress proxy. `runSandbox` starts it for the VM's lifetime and closes it on exit, abort,
  stall and timeout.
- `src/sandbox.ts`: `networkBackend()` (pasta or vsock), `buildDirectCommand()`, the macOS spawn
  path, `--watch-pid` (hive's own pid) and `--pidfile`, and the checks `systemInfo()` reports.
- `src/egress.ts`: `proxyEnv(url)` builds the proxy variables for either path (the guest's own
  port on macOS, the forwarded host port on Linux).
- `src/libkrun.ts`, `src/config.ts`, `src/fixes.ts`: the macOS dylib name, `current.img`, no
  `HIVE_NETWORK=direct` on macOS, and macOS wording for every failed check.
- `src/cli.ts`: `hive doctor` shows Hypervisor.framework, the vsock egress and the VM image on a
  Mac, and the "can't start a VM" message names what this platform needs.

**Deviations and things Phase 2/3 must know**

- libkrun loads its kernel bundle with `dlopen("libkrunfw.5.dylib")`, and dyld searches the system
  paths only. The launcher now preloads `libkrunfw.5.dylib` from libkrun's own directory (or
  `HIVE_LIBKRUNFW`), so the release bundle must keep the two dylibs together. Phase 4's native
  build sets the dylib ids and re-signs them.
- `vm/build.sh` ad-hoc signs the launcher on macOS with `vm/hive-vm.entitlements`. Phase 4's
  release build uses the same two keys; distribution still needs a Developer ID.
- `hive-vm-init` needs GNU coreutils' `env --chdir`; Fedora has it, Alpine's busybox does not. The
  test image installed `coreutils`.
- The launchd service, `recoverRuns` without `/proc` and the case-sensitive run image are still
  Phase 3. `hive run` from a checkout needs `HIVE_ROOTFS`; an installed release gets the image
  through `hive setup`.

**Exit criteria:** met for the networking half (a real `runSandbox` VM with proxy-only egress and
the Phase 0 negative tests). `hive run` end to end waits for the arm64 image.

### Phase 2 — arm64 rootfs image (2–3 days)

- Build `image/` for `linux/arm64` (a `podman machine` or an `ubuntu-24.04-arm` CI job) and check
  Chromium, Node 24, pi and `hive-export` on arm64.
- Export the container image's root filesystem and turn it into a raw disk image on the arm64
  runner (`mke2fs -d` or `mkfs.erofs`; macOS has no mkfs). This is a separate step from
  `vm/build-rootfs.sh`, which keeps producing the Linux folder rootfs.
- Name the macOS artifact `hive-rootfs-<hash>-linux-arm64.img` (or `.img.gz`), checksummed and
  signed like the app bundle; `release.ts` accepts an image, and Phase 4 adds the installer.
- Keep the license/source obligations current (Fedora, Chromium, node, pi; libkrunfw is already in
  `THIRD-PARTY.md`).

**Status: done; Phase 4 ships the app bundle and installer.** On an arm64 Linux host (or
a `podman machine`), `npm run build:image` then `npm run build:rootfs-image` exports the sandbox
image into a raw ext4 image named `hive-rootfs-<rootfs-id>-linux-arm64.img`, keeps the raw file
for `HIVE_ROOTFS`, and writes a gzipped copy, its SHA-256 and a `rootfs-info.json` naming
the `image/` tree it came from (the macOS release build refuses a mismatched image). The
[`macos-image`](../.github/workflows/macos-image.yml) workflow does the same on an
`ubuntu-24.04-arm` runner, then mounts the image and runs Node, Chromium and pi from inside it.
Fedora 45 ships Chromium and Node 24 for aarch64, so the image builds natively; the arm64 image
uses the same packages already listed in [THIRD-PARTY.md](THIRD-PARTY.md).

The release client is image-aware too. `release.ts` pairs `hive-<version>-darwin-arm64.tar.gz`
with `hive-rootfs-<id>-linux-arm64.img.gz`, verifies it against `SHA256SUMS`, gunzips it to
`rootfs/<id>/rootfs.img`, checks the ext4 superblock, and points `rootfs/current.img` at it.
`hive setup` does the same for the running bundle. Activation also repoints `rootfs/current`
(the Linux folder rootfs), which the setup path previously left dangling.

| Check | Result |
|---|---|
| Image | 1.75 GB of files → 2.55 GB ext4 → 604 MB gzip; Node v24.18.0, Chromium 157.0.8103.78, pi 1.6.0 |
| Boot on an M4 | read-only ext4 root with a rw overlay; `tsi=0`; only `lo` and a down `dummy0` |
| Network | proxy `200`; DNS, the LAN and a public IP all blocked |
| Release client | image downloaded, SHA-256 checked, ext4 checked, linked as `current.img` |

Phase 4 now packages it: `scripts/build-release-macos.sh` produces the
`hive-<version>-darwin-arm64` bundle that `installRelease` expects, with the image as its paired
asset. `hive run` from a checkout still needs `HIVE_ROOTFS` pointing at a built `.img`; an
installed release gets there through `hive setup`.

### Phase 3 — Hive platform plumbing (3–5 days)

- **`npm test` is green on macOS, and `ci.yml` runs it on a `macos-15` runner.** The last ten
  failures were the disk watchdog's `du -B1` (macOS accepts it but counts 512-byte blocks), git
  returning `/private/var` for paths the tests only knew as `/var`, `rmSync` following a cache
  symlink into a directory (the pruner now unlinks the link), the uninstall test's systemd file
  name (it asks `servicePaths()` now), and the two `install-cli.sh` execution tests (they were
  skipped off Linux until Phase 4 added the darwin-arm64 branch; they now run on both). The
  push-refusal test also names the remote's own `core.hooksPath`, so a developer-wide hook path
  cannot disable it.
- `src/config.ts`: default network mode per platform; accept `HIVE_RUNTIME=auto` (the CLI
  currently rejects the documented default, `src/cli.ts:1743`).
- `src/sandbox.ts` `libkrunAvailable()`/`systemInfo()`: HVF check, no pasta requirement, macOS
  check names and fixes.
- `src/runs.ts`: `recoverRuns` via the pidfile plus `ps -axo pid=,command=` on macOS; keep
  `/proc` on Linux.
- `src/diskwatch.ts` uses `du -s -k -x --` × 1024 now, so the same numbers hold on both
  platforms and the 512× undercount is gone. On macOS the run folder will live on the
  case-sensitive image: check free space on the host volume holding the image, not `statfs` on
  the mountpoint, and cap the image's growth. `src/stall.ts` is fine as is (`find -mmin` is
  portable).
- macOS run-image lifecycle: attach it at startup for the CLI, `hive serve` and the launchd
  service; keep a marker inside and refuse to run when it is not mounted; detach on shutdown; add
  it to `hive uninstall` and `hive doctor`.
- `src/usage.ts` is already platform-safe: it falls back to `os.freemem`, measures the disk with
  `statfs` and reports no temperature when `/sys` is absent. Keep it covered by a macOS job.
- `src/service.ts`: launchd already exists; fix the release-bundle command (it currently points at
  `lib/cli.js`, which a bundle does not ship).
- `src/release.ts`: platform/arch asset names (`darwin-arm64` app, `linux-arm64` rootfs image)
  and install paths (done in Phases 2/4).
- `install-cli.sh` (or a macOS installer): `shasum -a 256` fallback, zsh `PATH`, Gatekeeper note
  (done in Phase 4; the doc note is in `docs/INSTALL.md`).
- UI: "This computer" shows Hypervisor.framework and the vsock network; nothing else changes.

### Phase 4 — Release and distribution (2–4 days)

**Status: the build and install path is done (November 2026); a signed public release is the
remaining step.**

- `scripts/build-native-macos.sh` builds libkrun 1.19.8 from source and libkrunfw 5.6.2 from
  upstream's prebuilt kernel bundle, compiles the launcher with the HVF entitlements, sets the
  dylib ids, ad-hoc signs all three and verifies the launcher can load the bundled libkrun. Output
  is `build/native-macos/` (libkrun and libkrunfw together in `lib/`, `hive-vm` in
  `libexec/`); it is cached while the pins and launcher sources are unchanged.
- `scripts/build-release-macos.sh` builds the `hive-<version>-darwin-arm64.tar.gz` bundle with
  Node `darwin-arm64`, the esbuild CLI, `ui/dist`, the launcher, libkrun, libkrunfw and the arm64
  rootfs image, then writes a signed `SHA256SUMS` that also covers the image. It checks the
  image's ext4 superblock and `ROOTFS_VERSION` pairing, ships the libkrunfw GPL source and its
  kernel tarball, and can add the macOS assets to an existing Linux release directory.
- `versions.json` has `libkrunfw.macos.aarch64` and `libkrunfw.linux.aarch64` URLs with
  SHA-256; `scripts/check-updates.mjs` reads all three assets' GitHub-published digests and moves
  the arm64 URLs with the version.
- `install-cli.sh` now installs the `darwin-arm64` bundle on Apple silicon: it uses
  `shasum -a 256`, adds `~/.local/bin` to `~/.zprofile`/`.zshrc`, downloads the ~610 MB arm64
  image and checks Hypervisor.framework instead of KVM/pasta.
- `.github/workflows/macos-release.yml` (manual dispatch) reuses the arm64 image job, builds the
  bundle on `macos-15`, checks the tarball and signatures, and uploads it as a workflow artifact.
  It cannot boot HVF on GitHub's runners, and it writes an unsigned `SHA256SUMS`: a distributable
  release is still built on a Mac, then signed keyless by `promote.yml`.
- Docs: the macOS section in `docs/INSTALL.md`, the README, `AGENTS.md`, `docs/RELEASING.md`
  and this page.
- Later: publish and notarize a Developer ID build for distribution; Homebrew tap or cask; wire
  the macOS assets into a published release.

### Phase 4 results

| Check | Result |
|---|---|
| Native build | libkrun 1.19.8 and libkrunfw 5.6.2, launcher signed with both entitlements; `hive-vm --check` loads the bundled dylibs |
| Bundle | a `hive-0.5.5-darwin-arm64.tar.gz` bundle (55 MB); `hive doctor` reports HVF, bundled libkrun, vsock egress, launcher and image as ok |
| Image | a CI-built `hive-rootfs-<id>-linux-arm64.img.gz` (~604 MB), ext4 superblock, `current.img` install path and a `rootfs-info.json` image-tree check |
| Installer | the macOS branch installs a fake release under a temp HOME, picks the darwin asset, verifies with `shasum`, and writes the zsh PATH line once |
| Isolation | `npm run smoke:macos` on the M4: no IP network, TSI off, proxy 200, LAN/metadata 403, direct LAN/public/DNS/ping refused (10/10) |
| CI build | `macos-release.yml` builds the image on `ubuntu-24.04-arm` and the bundle on `macos-15`, and checks the tarball with `shasum` and the code signatures. It writes an unsigned `SHA256SUMS`. |

**Remaining:** a signed, published macOS release (and notarization for a Developer ID build) is
what a user can download; the build and install code is ready for it.

**Total: roughly 3–4 weeks** after the spike. The security/networking work (Phases 0–1) carries
almost all of the risk; Phases 2–4 are packaging and filesystem plumbing.

## Changes by file

Done in Phase 1 unless the row says otherwise.

| File | Change |
|---|---|
| `vm/hive-vm.c` | HVF/dylib guards, vsock-only network mode, read-only rootfs image, pidfile, macOS-safe flags |
| `vm/hive-vm.entitlements` (new), `vm/build.sh` | the two HVF/library-validation entitlements, and an ad-hoc signature on macOS |
| `image/hive-vm-init` | build the overlay over the read-only root image; start `hive-netd` |
| `image/hive-netd.c` (new) | TCP `127.0.0.1:3128` → `AF_VSOCK` cid 2 |
| `image/Containerfile` | build and install `hive-netd` (static) for the guest architecture |
| `src/sandbox.ts` | macOS spawn path, HVF check, rootfs image, labels; `systemInfo()` checks |
| `src/vsock.ts` (new) | the short host socket and the bridge to the egress proxy |
| `src/egress.ts` | `proxyEnv()` for the guest's vsock port as well as the forwarded host port |
| `src/pasta.ts`, `src/libkrun.ts` | dylib selection per platform (the pasta choice is only used on Linux) |
| `src/config.ts`, `src/fixes.ts` | `current.img`, no `HIVE_NETWORK=direct` on macOS, macOS check wording |
| `vm/build-rootfs.sh`, `scripts/build-rootfs-image.sh` (new) | **Phase 2:** Linux folder rootfs unchanged; build and compress the macOS raw image |
| `src/runs.ts` | **Phase 3:** `recoverRuns` without `/proc`; launcher pid |
| `src/diskwatch.ts` | **Phase 3:** portable `du` (done); host free space while runs live on the image (open) |
| `src/usage.ts`, `src/service.ts`, `src/uninstall.ts` | **Phase 3:** platform branches, run-image attach/detach; `hive uninstall` detaches it |
| `src/release.ts`, `src/cli.ts` | **Phase 2/3:** the macOS image asset and install path (done), macOS asset names and `HIVE_RUNTIME` validation (open) |
| `install-cli.sh` | **Phase 4:** the darwin-arm64 asset, `shasum -a 256`, zsh `PATH` and HVF advice (done) |
| `scripts/build-native-macos.sh`, `scripts/build-release-macos.sh` (new) | **Phase 4:** build libkrun/libkrunfw/the launcher, then the signed bundle and image (done) |
| `scripts/macos-smoke.mjs` (new) | **Phase 4:** the real-VM isolation check (`npm run smoke:macos`) |
| `scripts/kernel-remote.mjs` (new) | reads libkrunfw's `KERNEL_REMOTE` without GNU make, for the macOS GPL source asset |
| `versions.json`, `scripts/check-updates.mjs` | **Phase 4:** arm64 pins and their digests (done) |
| `.github/workflows/` | **Phase 3/4:** macOS unit-test job and arm64 rootfs image (done); the dispatchable macOS bundle build (done); macOS assets in a published release (open) |

## Risks

| Risk | Mitigation |
|---|---|
| Case-insensitive APFS breaks a folder-based rootfs and repos with case-colliding paths | rootfs as a read-only image over virtio-blk; run folders on a case-sensitive APFS image; tested in Phase 0 step 7 |
| The case-sensitive run image is not mounted after a crash or a failed `hdiutil attach` | marker file inside it, refuse to run, attach at every entry point, `hive doctor` |
| Disk accounting inside a sparse image | free space from the host volume, an image size cap, `du` on the mount only for run data |
| virtio-fs is slow for many small files (git, npm) on macOS | the rootfs is a block image now; measure `work/` and `io/` in Phase 0; if unusable, put `work/` on a virtio-blk image and export patches — a bigger change, decided on numbers |
| vsock-without-TSI does not behave as documented | the Phase 0 negative test is the gate; fallback is gvproxy with an explicit reduced-isolation label |
| Chromium, npm or git ignores the proxy and wants DNS | all honour the `*_PROXY` variables today; test each in Phase 0; npm's cache already lives in the VM |
| GitHub's macOS runners are VMs, and nested HVF needs an M3+ host and macOS 15+ | do not count on a VM boot in CI: unit tests and `hive-vm --check` there, the dispatchable `macos-release` build, and `scripts/macos-smoke.mjs` run by hand on real hardware |
| UNIX socket path longer than 104 bytes | short `/tmp/hv-XXXX.sock`; the ctl dir stays under the run folder |
| macOS sleep and the run time limit (`CLOCK_MONOTONIC` excludes sleep) | decide whether the limit is wall-clock or awake time; use a continuous clock if wall-clock |
| Signing and notarization | ad-hoc for local use; Developer ID + notarization only when distributing |

## Open decisions

1. **Apple silicon only (macOS 14+)** — Intel Macs are out. Accepted?
2. **Proxy-only egress by default**, with gvproxy only as an explicit reduced-isolation opt-in.
3. **Source build first**, signed/notarized installer later. The source path and the signed
   release build are done; publishing the signed macOS assets is the remaining step.
4. **arm64 rootfs image in CI** (`ubuntu-24.04-arm`) or a local `podman machine`.
5. **Linux stays on pasta** until macOS ships; unify later.
6. **Rootfs image format:** **ext4** (Phase 0: 104 MiB allocated, 39 MiB gzipped, boot in ~0.07 s,
   and it keeps file capabilities). erofs and squashfs were not compared; revisit only if Phase 2
   needs a smaller download.
7. **Run folders on a case-sensitive image by default** (recommended) rather than detecting and
   refusing case collisions. Phase 0 proved that case-sensitive APFS survives over virtio-fs, but
   the persistent image lifecycle is still open: macOS 27's `hdiutil create -type SPARSE` fails,
   and the ASIF/APFSX replacement needs a raw-device step (Phase 3).

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
