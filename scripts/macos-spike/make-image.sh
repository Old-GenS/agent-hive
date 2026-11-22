#!/usr/bin/env bash
# Build a minimal Alpine aarch64 ext4 image for the Phase 0 spike.
#
# No podman/docker/lima is needed: the first boot uses libkrun's TSI (network)
# to install packages into a shared Alpine rootfs, and the second boot runs
# mke2fs -d inside that guest to write a case-preserving ext4 image. The full
# Fedora hive image is Phase 2 and belongs on an arm64 Linux runner.
#
# The resulting image is a test image, not the hive image: it has socat, curl,
# git, node/npm and e2fsprogs, and the guest/run.sh dispatcher.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRATCH=${SCRATCH:-$ROOT/.scratch}
VM=${VM:-$SCRATCH/spike/vm-spike}
ALPINE_VERSION=${ALPINE_VERSION:-3.22.8}
ALPINE_URL=https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/alpine-minirootfs-${ALPINE_VERSION}-aarch64.tar.gz
ROOTFS=${ROOTFS:-$SCRATCH/rootfs/alpine}
IMAGES=${IMAGES:-$SCRATCH/images}
IMAGE=${IMAGE:-$IMAGES/rootfs-test.img}

[ -x "$VM" ] || { echo "error: build vm-spike first (see README)" >&2; exit 1; }
mkdir -p "$ROOTFS" "$IMAGES" "$SCRATCH/logs"

if [ ! -x "$ROOTFS/bin/busybox" ]; then
    echo "downloading Alpine $ALPINE_VERSION"
    curl -fL --retry 3 -o "$SCRATCH/rootfs/alpine-minirootfs.tar.gz" "$ALPINE_URL"
    rm -rf "$ROOTFS"
    mkdir -p "$ROOTFS"
    tar -xzf "$SCRATCH/rootfs/alpine-minirootfs.tar.gz" -C "$ROOTFS" --no-same-owner
fi
printf 'nameserver 1.1.1.1\n' > "$ROOTFS/etc/resolv.conf"

cat > "$ROOTFS/run-install.sh" <<'EOF'
#!/bin/sh
set -e
echo INSTALL_START
apk update
apk add --no-cache socat curl git nodejs npm e2fsprogs e2fsprogs-extra libcap ca-certificates tzdata
echo INSTALL_DONE
EOF
chmod +x "$ROOTFS/run-install.sh"

# TSI build mode: no --vsock, so the implicit vsock carries the host network.
echo "installing packages in the build VM (TSI on; not a security test)"
"$VM" --root "$ROOTFS" --cpus 4 --ram 4096 -- /run-install.sh 2>&1 | tee "$SCRATCH/logs/image-install.log"

cat > "$ROOTFS/run-mkimage.sh" <<'EOF'
#!/bin/sh
set -ex
mkdir -p /mnt/images
mount -t virtiofs images /mnt/images
rm -rf /dev/shm/root
mkdir -p /dev/shm/root
for d in bin etc home lib media opt root sbin srv usr var; do
  cp -a "/$d" /dev/shm/root/ 2>/dev/null || true
done
mkdir -p /dev/shm/root/dev /dev/shm/root/proc /dev/shm/root/sys /dev/shm/root/tmp
mkdir -p /dev/shm/root/mnt /dev/shm/root/mnt/scripts /dev/shm/root/mnt/work
mkdir -p /dev/shm/root/run /dev/shm/root/boot /dev/shm/root/casecheck
chmod 1777 /dev/shm/root/tmp
cp /etc/resolv.conf /dev/shm/root/etc/resolv.conf
echo lower > /dev/shm/root/casecheck/a.txt
echo upper > /dev/shm/root/casecheck/A.txt
cp /run.sh /dev/shm/root/run.sh
chmod 755 /dev/shm/root/run.sh
rm -f /dev/shm/root/run-install.sh /dev/shm/root/run-mkimage.sh
rm -f /mnt/images/rootfs-test.img
truncate -s 1536M /mnt/images/rootfs-test.img
# -E no_copy_xattrs: the package tree has xattrs that macOS's virtual filesystem
# cannot enumerate (mke2fs stops at "arch"). A capability is added to a copy of
# the image with debugfs in the capability check instead.
mkfs.ext4 -F -L hive-root -E no_copy_xattrs -d /dev/shm/root /mnt/images/rootfs-test.img
rm -rf /dev/shm/root
echo MKIMAGE_DONE
EOF
chmod +x "$ROOTFS/run-mkimage.sh"

mkdir -p "$ROOTFS/mnt/scripts"
cp "$ROOT/scripts/macos-spike/guest/run.sh" "$ROOTFS/run.sh"
chmod +x "$ROOTFS/run.sh"

echo "building $IMAGE in the guest"
"$VM" --root "$ROOTFS" --cpus 4 --ram 4096 --share images="$IMAGES" -- /run-mkimage.sh 2>&1 | tee "$SCRATCH/logs/image-mkfs.log"

rm -f "$ROOTFS/run-install.sh" "$ROOTFS/run-mkimage.sh"
ls -lh "$IMAGE"
du -h "$IMAGE"
