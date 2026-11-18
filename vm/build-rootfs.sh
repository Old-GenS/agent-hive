#!/usr/bin/env bash
# Export the sandbox image to a plain rootfs directory. The libkrun launcher mounts that
# directory read-only as the guest's /, so this only has to run again after the image changes.
set -euo pipefail

IMAGE=${HIVE_IMAGE:-localhost/agent-hive-sandbox:latest}
BASE=${HIVE_ROOTFS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive/rootfs}
mkdir -p "$BASE"

id=$(podman image inspect --format '{{.Id}}' "$IMAGE" | cut -c1-12)
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
podman rm "$cid"
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

for path in "$BASE"/*; do
  [[ -L "$path" ]] && continue
  [[ -d "$path" ]] || continue
  name=$(basename "$path")
  [[ "$name" == "$id" ]] && continue
  [[ -n "$prev" && "$name" == "$prev" ]] && continue
  rm -rf "$path"
done

echo "$dest"
