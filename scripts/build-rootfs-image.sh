#!/usr/bin/env bash
# Build the macOS VM root filesystem: the sandbox image exported into a raw ext4 image that
# vm/hive-vm attaches read-only with virtio-blk (docs/MACOS.md, Phase 2). A folder rootfs cannot
# be used on a Mac: APFS is case-insensitive, and an exported folder loses root ownership, setuid
# bits and device nodes. Run this on Linux (an arm64 host or podman machine); macOS has no mkfs.
#
# HIVE_IMAGE             sandbox image to export   (default localhost/agent-hive-sandbox:latest)
# HIVE_ROOTFS_IMAGE_DIR  output folder             (default <repo>/build/rootfs-image)
# Prints the .img.gz path on stdout; progress goes to stderr. The raw .img stays next to it for
# a local HIVE_ROOTFS, and the gzipped pair plus its .sha256 is what a release would ship.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${HIVE_IMAGE:-localhost/agent-hive-sandbox:latest}
OUT=${HIVE_ROOTFS_IMAGE_DIR:-$repo_root/build/rootfs-image}

die() {
  echo "build-rootfs-image: $*" >&2
  exit 1
}

[[ "$(uname -s)" == Linux ]] || die "build the VM image on Linux; macOS has no mkfs or ext4 tools (use an arm64 host or a podman machine)"
for tool in podman mke2fs debugfs e2fsck gzip sha256sum tar; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is missing (e2fsprogs, gzip and podman are required)"
done

case "$(uname -m)" in
  aarch64|arm64) platform=linux-arm64 ;;
  x86_64|amd64) platform=linux-x86_64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

podman image inspect "$IMAGE" >/dev/null 2>&1 || die "no image $IMAGE; build it with npm run build:image"
# Same id the Linux rootfs uses: the image/ tree plus the installed RPMs, so a rebuild of an
# unchanged image keeps the id and nobody re-downloads the filesystem (see scripts/rootfs-id.mjs).
image_tree=$(git -C "$repo_root" rev-parse HEAD:image 2>/dev/null) \
  || die "$repo_root is not a git checkout, so the image/ tree is unknown"
packages=$(podman run --rm "$IMAGE" hive-packages)
id=$(printf '%s\n' "$packages" | node "$repo_root/scripts/rootfs-id.mjs" --image-tree "$image_tree")
[[ "$id" =~ ^[0-9a-f]{12}$ ]] || die "unexpected rootfs id: $id"

name=$(node "$repo_root/scripts/rootfs-image.mjs" name "$id" "$platform")
img=${name%.gz}
mkdir -p "$OUT"
img_path="$OUT/$img"
gz_path="$OUT/$name"
rm -f "$img_path" "$gz_path" "$gz_path.sha256"

tmp=$(mktemp -d "$OUT/.tmp-XXXXXX")
cid=""
cleanup() {
  if [[ -n "$cid" ]]; then
    podman rm -f "$cid" >/dev/null 2>&1 || true
  fi
  # Packaged directories can be read-only (ca-trust) or unreadable to their owner; the image
  # builder runs as that user, so hand access back before deleting.
  chmod -R u+rwX "$tmp" 2>/dev/null || true
  rm -rf "$tmp" 2>/dev/null || true
}
trap cleanup EXIT

cid=$(podman create "$IMAGE" true)
podman export "$cid" | tar -x -C "$tmp" --exclude="dev/*"
podman rm "$cid" >/dev/null
cid=""
# The base image ships directories its owner cannot read or write (ca-certificates is 0555,
# systemd's dissect-root is not readable); du and mke2fs run as this user, so restore owner access
# first. True of Debian and Fedora alike.
chmod -R u+rwX "$tmp"

[[ -f "$tmp/usr/local/bin/hive-vm-init" ]] || die "$IMAGE has no /usr/local/bin/hive-vm-init; rebuild it with npm run build:image"
[[ -x "$tmp/usr/local/bin/hive-netd" ]] || die "$IMAGE has no /usr/local/bin/hive-netd; rebuild it with npm run build:image"

if ! content=$(du -sb --apparent-size "$tmp" | cut -f1); then
  echo "build-rootfs-image: cannot measure $tmp; entries this user cannot read:" >&2
  find "$tmp" ! -readable -printf "%M %u %p\n" 2>/dev/null | head -10 >&2
  exit 1
fi
size=$(node "$repo_root/scripts/rootfs-image.mjs" size "$content")
echo "build-rootfs-image: rootfs $id, $content bytes of files, image $size bytes" >&2

truncate -s "$size" "$img_path"
mke2fs -F -q -t ext4 -L hive-root -d "$tmp" "$img_path"
e2fsck -fn "$img_path" >/dev/null 2>&1 || die "e2fsck rejected $img_path"
debugfs -R "stat /usr/local/bin/hive-netd" "$img_path" 2>/dev/null | grep -q "Inode:" \
  || die "hive-netd is missing from $img_path"

gzip -9 -n -c "$img_path" > "$gz_path"
( cd "$OUT" && sha256sum "$name" > "$name.sha256" )

# Pair the image with the image/ tree it came from, so a release build can refuse a stale guest
# image (the same check the Linux release makes with rootfs-info.json).
image_tree=$(git -C "$repo_root" rev-parse HEAD:image 2>/dev/null || true)
if [[ -z "$image_tree" ]]; then
  echo "build-rootfs-image: warning: no git image tree; a release build will refuse this image without HIVE_ROOTFS_INFO" >&2
fi
printf '{"rootfs":"%s","imageTree":"%s","built":"%s"}\n' "$id" "$image_tree" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/rootfs-info.json"

echo "build-rootfs-image: $gz_path ($(du -h "$gz_path" | cut -f1))" >&2
echo "$gz_path"
