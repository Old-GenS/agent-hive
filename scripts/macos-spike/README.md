# macOS Phase 0 spike

This is the throwaway harness for Phase 0 of [docs/MACOS.md](../../docs/MACOS.md):
it proves that a libkrun VM on Apple silicon/HVF can boot a read-only raw rootfs
over virtio-blk, with **no TSI and no virtio-net**, and reach the outside only
through one vsock port wired to hive's egress proxy. It is not part of hive's
product build; Phase 1 moves the pieces into `vm/hive-vm.c` and `src/sandbox.ts`.

Everything build-related lives under `.scratch/` (gitignored). The scripts
never write to `~/.cargo`, `/usr/local` or Homebrew.

## Machine tested

- Apple M4, macOS 27.0.1 (build 26A434), arm64, `sysctl -n kern.hv_support` = 1
- Apple clang 21.0.0, Rust 1.99.1, no podman/docker/lima, no Homebrew `lld`
- Results: see [docs/MACOS.md](../../docs/MACOS.md#phase-0-results).

## 1. Build libkrun 1.19.8 and libkrunfw 5.6.2

```bash
cd <repo>
scripts/macos-spike/build-libkrun.sh
```

It builds with `make BLK=1 NET=1`, installs into `.scratch/prefix`, downloads
`.scratch/libkrunfw/libkrunfw-prebuilt-aarch64.tgz` and compiles
`libkrunfw.5.dylib`. The recipe works around three sandbox/toolchain issues:

- `rust-lld` is symlinked as `toolchain/ld.lld` and selected with `--ld-path`.
- Cargo uses `CARGO_HOME=.scratch/cargo` (seeded from the read-only `~/.cargo`).
- bindgen build scripts link `@rpath/libclang.dylib` without an rpath; a symlink
  at `libkrun/target/release/libclang.dylib` is enough for dyld.

Expected artifacts:

```
.scratch/prefix/lib/libkrun.1.19.8.dylib
.scratch/prefix/lib/libkrunfw.5.dylib
```

## 2. Build the launcher

```bash
clang -O2 -Wall -Wextra -Werror \
  -I.scratch/prefix/include -L.scratch/prefix/lib -lkrun \
  -Wl,-rpath,"$PWD/.scratch/prefix/lib" \
  -o .scratch/spike/vm-spike scripts/macos-spike/vm-spike.c
codesign --force --sign - --entitlements scripts/macos-spike/entitlements.plist \
  .scratch/spike/vm-spike
```

The two entitlements are the ones krunkit uses:
`com.apple.security.hypervisor` and
`com.apple.security.cs.disable-library-validation`. Ad-hoc signing is enough on
your own Mac. `krun_set_exec` is always given a minimal guest environment;
passing `NULL` would put the host environment on the kernel command line and
overflow it.

## 3. Build the test image

```bash
npm run build                 # dist/egress.js for host-bridge.mjs
scripts/macos-spike/make-image.sh
```

The first boot uses libkrun's TSI (network) to run `apk add` into a shared
Alpine 3.22.8 aarch64 rootfs. The second boot runs `mke2fs -d` inside the guest
on a tmpfs staging copy and writes `.scratch/images/rootfs-test.img`
(ext4, 1.5 GiB nominal). The image is a test image: `socat`, `curl`, `git`,
Node/npm and e2fsprogs, plus `/run.sh`, which mounts the `scripts` share and
runs `$GUEST_SCRIPT`.

No podman/docker/lima is involved, and no Fedora rootfs is used; the full Fedora
hive image is Phase 2 and should be built on an arm64 Linux runner.

## 4. Run the checks

All VM runs below use `--vsock`, which calls
`krun_disable_implicit_vsock()` + `krun_add_vsock(ctx, 0)`; that is the TSI-off
mode. The image is attached read-only with `krun_add_disk(..., read_only=true)`
and mounted with the `ro` option.

### Boot and the read-only root

```bash
.scratch/spike/vm-spike \
  --rootfs "$PWD/.scratch/images/rootfs-test.img" \
  --vsock 1024:/tmp/hv-nothing.sock \
  --share scripts="$PWD/scripts/macos-spike/guest" \
  --env GUEST_SCRIPT=boot.sh \
  --cpus 2 --ram 2048 -- /run.sh
```

### Negative network tests and the egress proxy

Terminal 1 (host):

```bash
node scripts/macos-spike/host-bridge.mjs --socket /tmp/hv-bridge.sock --debug
```

Terminal 2 (VM; use your LAN gateway for `LAN_IP`):

```bash
.scratch/spike/vm-spike \
  --rootfs "$PWD/.scratch/images/rootfs-test.img" \
  --vsock 1024:/tmp/hv-bridge.sock \
  --share scripts="$PWD/scripts/macos-spike/guest" \
  --env GUEST_SCRIPT=security.sh \
  --env LAN_IP=192.168.1.1 \
  --cpus 2 --ram 2048 -- /run.sh
```

Direct curl to the LAN, a public IP and a hostname, and `ping`, must all fail;
`curl -x http://127.0.0.1:3128` must get 200 for HTTP and HTTPS, and the proxy
must answer 403 for the LAN and 169.254.169.254.

### virtio-fs throughput and npm

```bash
mkdir -p .scratch/work-throughput .scratch/npm-cache
npm --cache "$PWD/.scratch/npm-cache" pack \
  --pack-destination "$PWD/.scratch/work-throughput" \
  "$PWD/scripts/macos-spike/npm/tiny"
.scratch/spike/vm-spike \
  --rootfs "$PWD/.scratch/images/rootfs-test.img" \
  --vsock 1024:/tmp/hv-nothing.sock \
  --share scripts="$PWD/scripts/macos-spike/guest" \
  --share work="$PWD/.scratch/work-throughput" \
  --env GUEST_SCRIPT=perf.sh \
  --cpus 4 --ram 4096 -- /run.sh
```

### vsock echo and throughput

```bash
node scripts/macos-spike/vsock-probe.mjs sink /tmp/hv-sink.sock
# in the VM: dd if=/dev/zero bs=1M count=128 | socat - VSOCK-CONNECT:2:1024
```

### Case-sensitive APFS + git

```bash
scripts/macos-spike/setup-case-volume.sh   # needs raw-device permission
.scratch/spike/vm-spike \
  --rootfs "$PWD/.scratch/images/rootfs-test.img" \
  --vsock 1024:/tmp/hv-nothing.sock \
  --share scripts="$PWD/scripts/macos-spike/guest" \
  --share work="$PWD/.scratch/case/mnt/work" \
  --env GUEST_SCRIPT=case.sh \
  --cpus 2 --ram 2048 -- /run.sh
```

`setup-case-volume.sh` uses a temporary RAM disk because macOS 27's
`hdiutil create -type SPARSE` fails with "Directory not empty". The persistent
run-image lifecycle (ASIF image + APFSX volume, attach/detach) is Phase 3 work.

## What the spike established

- HVF boots the read-only ext4 image in ~0.07 s of guest uptime (median,
  0.128 s host wall including launch and shutdown).
- virtio-fs is not a bottleneck: 256 MiB write in ~0.15–0.17 s, 2000 small files in
  ~0.41–0.50 s, small npm install in ~0.18 s.
- vsock moves 128 MiB at ~850–955 MiB/s.
- TSI off + one vsock port is a hard boundary: direct LAN, public IP, hostname
  and ping all fail; the egress proxy still works and refuses non-public
  destinations.
- The read-only image is enforced by the host and cannot be remounted rw; case
  collisions survive in the image and on a case-sensitive APFS share.
- File capabilities survive in the ext4 image.

Numbers and the exact gate results are in
[docs/MACOS.md](../../docs/MACOS.md#phase-0-results).
