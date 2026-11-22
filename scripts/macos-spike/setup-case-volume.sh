#!/usr/bin/env bash
# Create the case-sensitive APFS volume used by guest/case.sh.
#
# macOS 27 no longer creates sparse images with `hdiutil create -type SPARSE`
# ("Directory not empty"), and the new ASIF/APFS path still needs a privileged
# raw-device step. For the spike this uses a temporary RAM disk instead; the
# filesystem semantics (case-sensitive APFS shared over virtio-fs) are the same.
#
# WARNING: this formats the RAM disk it creates. It never touches an existing
# disk, but it does need permission to write /dev/diskN (run it outside the
# workspace sandbox, or with sudo if your RAM disk is owned by root).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MOUNT=${1:-$ROOT/.scratch/case/mnt}
mkdir -p "$MOUNT"

ATTACH=$(diskutil image attach ram://4g --noMount)
DISK=$(printf '%s\n' "$ATTACH" | awk '/^\/dev\// {print $1; exit}')
[ -n "$DISK" ] || { echo "error: could not attach a RAM disk" >&2; exit 1; }

echo "formatting $DISK as case-sensitive APFS"
newfs_apfs -o case=sensitive -v HiveCaseCS "$DISK"
diskutil mountDisk "$DISK"
VOL=$(diskutil list | grep HiveCaseCS | grep -o 'disk[0-9]*s[0-9]*' | tail -1)
[ -n "$VOL" ] || { echo "error: APFS volume not found" >&2; exit 1; }
diskutil unmount "$VOL" >/dev/null
diskutil mount -mountPoint "$MOUNT" "$VOL" >/dev/null

rm -rf "$MOUNT/src" "$MOUNT/bare.git" "$MOUNT/work"
mkdir "$MOUNT/src"
cd "$MOUNT/src"
git init -q
git config user.name Spike
git config user.email spike@example.invalid
echo lower > a.txt
echo upper > A.txt
git add a.txt A.txt
git commit -qm 'case files'
cd ..
git clone -q --bare src bare.git
git clone -q bare.git work

echo "CASE_VOLUME=$MOUNT"
echo "CASE_DISK=$DISK"
echo "cleanup: diskutil unmount '$MOUNT' && diskutil eject '$DISK'"
