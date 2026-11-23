#!/usr/bin/env bash
# Build a signed macOS arm64 Agent Hive release: an app bundle with Node, the bundled CLI, the
# VM launcher and libkrun/libkrunfw, plus the arm64 VM image. Run from the repo root.
#
#   bash scripts/build-release-macos.sh --rootfs-image <hive-rootfs-<id>-linux-arm64.img[.gz]>
#
# The image is built on arm64 Linux (scripts/build-rootfs-image.sh in the macos-image workflow);
# macOS cannot make ext4 filesystems. If release/<version>/ already holds the Linux assets, this
# adds the macOS assets and re-signs one SHA256SUMS covering all of them, so one GitHub release can
# carry both platforms. Needs the release signing key (docs/RELEASING.md).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root=$(pwd)
rootfs_image=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootfs-image=*)
      rootfs_image=${1#*=}
      shift
      ;;
    --rootfs-image)
      if [[ $# -lt 2 ]]; then
        echo "build-release-macos: --rootfs-image needs a path" >&2
        exit 2
      fi
      rootfs_image=$2
      shift 2
      ;;
    *)
      echo "build-release-macos: unknown argument \"$1\"" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "build-release-macos: $*" >&2
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || die "this release build is macOS-only"
[[ "$(uname -m)" == arm64 ]] || die "only the arm64 macOS release exists"

if [[ -z "$rootfs_image" ]]; then
  rootfs_image=${HIVE_ROOTFS_IMAGE:-}
fi
if [[ -z "$rootfs_image" ]]; then
  shopt -s nullglob
  candidates=(build/rootfs-image/hive-rootfs-*-linux-arm64.img.gz)
  shopt -u nullglob
  [[ ${#candidates[@]} -gt 0 ]] || die "no arm64 image: pass --rootfs-image (build one with npm run build:rootfs-image on arm64 Linux)"
  rootfs_image=${candidates[0]}
fi
[[ -f "$rootfs_image" ]] || die "rootfs image not found: $rootfs_image"

version=$(node -p "require('./package.json').version")
if [[ -n "${HIVE_RELEASE_VERSION:-}" ]]; then
  version=$HIVE_RELEASE_VERSION
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(nightly|dev|beta)\.[0-9]+)?$ ]] \
    || die "HIVE_RELEASE_VERSION must look like 1.2.3 or 1.2.3-nightly.4 (got \"$version\")"
fi
NODE_VERSION=${HIVE_NODE_VERSION:-$(node -p "require('./versions.json').node")}
key=${HIVE_SIGNING_KEY:-$HOME/.config/agent-hive/release-signing-key.pem}
[[ -f "$key" ]] || die "signing key $key not found (create it with node scripts/keygen.mjs $key)"

out="release/$version"
mkdir -p "$out"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# Keep npm's cache in the workspace: a release build should not depend on a writable ~/.npm.
export npm_config_cache="${npm_config_cache:-$root/build/npm-cache}"
npm run build
npm run build:ui

native=$(bash scripts/build-native-macos.sh | tail -n 1)
[[ -n "$native" && -f "$native/lib/libkrun.1.dylib" && -f "$native/lib/libkrunfw.5.dylib" && -f "$native/libexec/hive-vm" ]] \
  || die "scripts/build-native-macos.sh did not produce libkrun, libkrunfw and libexec/hive-vm"

# The image is shipped as hive-rootfs-<id>-linux-arm64.img.gz. Accept either the gzipped artifact
# or the raw image; keeping the gzipped name and contents identical to the ARM runner's artifact
# is what lets the macOS client pair it with this app bundle.
case "$rootfs_image" in
  *.img.gz)
    gzip -t "$rootfs_image" || die "$rootfs_image is not a valid gzip file"
    name=$(basename "$rootfs_image")
    image_arg="$rootfs_image"
    ;;
  *.img)
    name=$(basename "${rootfs_image%.img}").img.gz
    image_arg=""
    ;;
  *) die "unexpected image name: $rootfs_image" ;;
esac
[[ "$name" =~ ^hive-rootfs-([0-9a-f]{12})-linux-arm64\.img\.gz$ ]] || die "image name must look like hive-rootfs-<12 hex>-linux-arm64.img.gz (got $name)"
rver=${BASH_REMATCH[1]}

# Verify the ext4 superblock magic (0xef53 at offset 1024 + 0x38), the same check release.ts makes.
# Read only the first 1082 bytes, even from the gzip, instead of decompressing 2.5 GB to /tmp.
if [[ "$rootfs_image" == *.img ]]; then
  magic=$(dd if="$rootfs_image" bs=1 skip=1080 count=2 2>/dev/null | od -An -tx1 | tr -d ' \n')
else
  magic=$( (gzip -dc "$rootfs_image" 2>/dev/null || true) | dd bs=1 skip=1080 count=2 2>/dev/null | od -An -tx1 | tr -d ' \n')
fi
[[ "$magic" == "53ef" ]] || die "the image is not ext4 (superblock magic $magic, expected 53ef)"

if [[ -z "$image_arg" ]]; then
  gzip -9 -n -c "$rootfs_image" > "$out/$name"
else
  cp "$rootfs_image" "$out/$name"
fi

app="$stage/hive-$version"
mkdir -p "$app/bin" "$app/lib" "$app/libexec" "$app/ui" "$app/share/licenses/agent-hive"
cp "$native/lib/libkrun.1.dylib" "$app/lib/libkrun.1.dylib"
cp "$native/lib/libkrunfw.5.dylib" "$app/lib/libkrunfw.5.dylib"
cp "$native/libexec/hive-vm" "$app/libexec/hive-vm"
cp -R "$native/share/licenses/." "$app/share/licenses/"
cp LICENSE "$app/share/licenses/agent-hive/LICENSE"
cp -R ui/dist "$app/ui/dist"

# bin/hive is a POSIX sh wrapper. macOS readlink has no -f, so resolve symlinks in a loop; the
# installer links ~/.local/bin/hive at the version's bin/hive.
cat > "$app/bin/hive" <<'EOF'
#!/bin/sh
self=$0
while [ -L "$self" ]; do
  dir=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd -P)
  target=$(readlink "$self")
  case $target in
    /*) self=$target ;;
    *) self=$dir/$target ;;
  esac
done
root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)
HIVE_BUNDLE_ROOT=$root exec "$root/libexec/node" "$root/lib/hive.mjs" "$@"
EOF
chmod 755 "$app/bin/hive"

npx esbuild dist/cli.js --bundle --platform=node --format=esm --target=node24 \
  --outfile="$app/lib/hive.mjs" \
  --banner:js="import { createRequire as __hiveRequire } from 'node:module'; const require = __hiveRequire(import.meta.url);"

# The bundle ships its own Node, checked against nodejs.org's SHASUMS256.txt.
curl -fsSL -o "$stage/node-v$NODE_VERSION-darwin-arm64.tar.gz" \
  "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
curl -fsSL -o "$stage/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
(cd "$stage" && grep " node-v$NODE_VERSION-darwin-arm64.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null)
tar -xzf "$stage/node-v$NODE_VERSION-darwin-arm64.tar.gz" -C "$stage" "node-v$NODE_VERSION-darwin-arm64/bin/node"
cp "$stage/node-v$NODE_VERSION-darwin-arm64/bin/node" "$app/libexec/node"
chmod 755 "$app/libexec/node"

echo "$version" > "$app/VERSION"
echo "$rver" > "$app/ROOTFS_VERSION"
tar -C "$stage" -czf "$out/hive-$version-darwin-arm64.tar.gz" "hive-$version"

# libkrunfw contains the Linux kernel (GPL-2.0), so publish its corresponding source and the
# kernel tarball its Makefile builds from. There is no passt source on macOS: there is no pasta.
if [[ "${HIVE_RELEASE_SKIP_SOURCES:-}" == "1" ]]; then
  echo "build-release-macos: skipping the GPL source assets (HIVE_RELEASE_SKIP_SOURCES=1)"
else
  libkrunfw_version=$(node -p "require('./versions.json').libkrunfw.version")
  libkrunfw_source=$(node -p "require('./versions.json').libkrunfw.source")
  curl -fsSL -o "$out/libkrunfw-$libkrunfw_version-source.tar.gz" "$libkrunfw_source"
  makefile=$(tar -tzf "$out/libkrunfw-$libkrunfw_version-source.tar.gz" | grep -E '^[^/]+/Makefile$' | head -n1)
  [[ -n "$makefile" ]] || die "no Makefile in $libkrunfw_source"
  srcdir=$(mktemp -d)
  tar -xzf "$out/libkrunfw-$libkrunfw_version-source.tar.gz" -C "$srcdir" "$makefile"
  # BSD make has no --eval, so the small helper expands the Makefile's own variables
  # (such as $(KERNEL_VERSION)) instead of running GNU make.
  kernel_remote=$(node scripts/kernel-remote.mjs "$srcdir/$makefile") \
    || die "could not read KERNEL_REMOTE from $makefile"
  rm -rf "$srcdir"
  kernel_file=$(basename "$kernel_remote")
  curl -fsSL -o "$out/kernel-source-$kernel_file" "$kernel_remote"
fi

# Recompute the sums over every asset in the release directory, so adding the macOS pieces to a
# Linux release (or the other way round) leaves one signed SHA256SUMS covering both.
(
  cd "$out"
  # The app is a .tar.gz; the VM image is a .img.gz, so it needs its own pattern or clients would
  # find no checksum for the rootfs they download.
  shopt -s nullglob
  assets=(hive-*.tar.gz "$name")
  shasum -a 256 "${assets[@]}" > SHA256SUMS
  shopt -u nullglob
  if [[ "${HIVE_RELEASE_SKIP_SOURCES:-}" != "1" ]]; then
    for file in libkrunfw-*-source.tar.gz kernel-source-*; do
      if [[ -f "$file" ]]; then shasum -a 256 "$file" >> SHA256SUMS; fi
    done
    # A Linux build in the same directory has this asset too.
    for file in passt-*-source.tar.xz; do
      if [[ -f "$file" ]]; then shasum -a 256 "$file" >> SHA256SUMS; fi
    done
  fi
)
node scripts/sign.mjs "$key" "$out/SHA256SUMS"

ls -l "$out"
