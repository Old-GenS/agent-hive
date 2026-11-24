#!/usr/bin/env bash
# Export the sandbox image to a plain rootfs directory. The libkrun launcher mounts that
# directory read-only as the guest's /, so this only has to run again after the image changes.
set -euo pipefail

IMAGE=${HIVE_IMAGE:-localhost/agent-hive-sandbox:latest}
BASE=${HIVE_ROOTFS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive/rootfs}
mkdir -p "$BASE"

# The id must change when the image changes and stay put when it did not, because an installed
# hive downloads the VM filesystem only when the id differs. A podman image id cannot do that:
# `build:image:fresh` builds with --no-cache, so an unchanged image still gets a new id and every
# release would make every install re-download the whole thing. The `image/` tree this checkout
# built from plus the installed RPMs is what a task actually sees, so that is the id.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image_tree=$(git -C "$repo_root" rev-parse HEAD:image 2>/dev/null || true)
if [[ -z "$image_tree" ]]; then
  echo "hive-vm: $repo_root is not a git checkout, so the image/ tree is unknown; the rootfs id would not be stable" >&2
  exit 1
fi
packages=$(podman run --rm "$IMAGE" hive-packages)
id=$(printf '%s\n' "$packages" | node "$repo_root/scripts/rootfs-id.mjs" --image-tree "$image_tree")
dest="$BASE/$id"

if [[ -e "$dest/.complete" ]]; then
  ln -sfn "$id" "$BASE/current"
  echo "$dest"
  exit 0
fi

tmp=$(mktemp -d "$BASE/.tmp-XXXXXX")
cid=""
cleanup() {
  if [[ -n "$cid" ]]; then
    podman rm -f "$cid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

cid=$(podman create "$IMAGE" true)
podman export "$cid" | tar -x -C "$tmp" --exclude='dev/*'
podman rm "$cid" >/dev/null
cid=""

if [[ ! -f "$tmp/usr/local/bin/hive-vm-init" ]]; then
  echo "hive-vm: $IMAGE has no /usr/local/bin/hive-vm-init; rebuild the image (npm run build:image)" >&2
  exit 1
fi

mv "$tmp" "$dest"
touch "$dest/.complete"
trap - EXIT

# Keep the root a task may still be running on, then point current at the new one.
prev=$(readlink "$BASE/current" 2>/dev/null || true)
ln -sfn "$id" "$BASE/current"

# Only rootfs directories are ours to delete: anything else in $BASE is left alone.
for path in "$BASE"/*; do
  [[ -L "$path" ]] && continue
  [[ -d "$path" ]] || continue
  name=$(basename "$path")
  [[ "$name" =~ ^[0-9a-f]{12}$ ]] || continue
  [[ "$name" == "$id" ]] && continue
  [[ -n "$prev" && "$name" == "$prev" ]] && continue
  rm -rf "$path"
done

echo "$dest"
