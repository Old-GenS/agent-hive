#!/usr/bin/env bash
# Build a signed Agent Hive release: an app bundle with Node, the bundled CLI, the VM launcher,
# the native pieces and a static pasta fallback, plus the VM rootfs as a separate download. Run
# from the repo root (or via `npm run release`). Needs the release signing key; see
# docs/RELEASING.md.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

version=$(node -p "require('./package.json').version")
# HIVE_RELEASE_VERSION lets CI build a beta prerelease without committing a package.json bump.
if [[ -n "${HIVE_RELEASE_VERSION:-}" ]]; then
  version=$HIVE_RELEASE_VERSION
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]]; then
    echo "build-release: HIVE_RELEASE_VERSION must look like 1.2.3 or 1.2.3-beta.4 (got \"$version\")" >&2
    exit 1
  fi
fi
# The bundled Node version is a pin too; HIVE_NODE_VERSION still overrides it.
NODE_VERSION=${HIVE_NODE_VERSION:-$(node -p "require('./versions.json').node")}
key=${HIVE_SIGNING_KEY:-$HOME/.config/agent-hive/release-signing-key.pem}
if [[ ! -f "$key" ]]; then
  echo "build-release: signing key $key not found (create it with node scripts/keygen.mjs $key)" >&2
  exit 1
fi

out="release/$version"
rm -rf "$out"
mkdir -p "$out"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

npm run build
npm run build:ui

# The old-glibc launcher, libkrun, libkrunfw and the static pasta come from build-native.sh, which
# builds inside the pinned manylinux container and checks the result (see docs/RELEASING.md). Only
# its last output line is the output dir; the earlier ones are progress and check messages.
native=$(bash scripts/build-native.sh | tail -n 1)
if [[ -z "$native" || ! -f "$native/libexec/hive-vm" || ! -f "$native/libexec/pasta" ]]; then
  echo "build-release: scripts/build-native.sh did not produce libexec/hive-vm and libexec/pasta" >&2
  exit 1
fi

# The rootfs is exported from the sandbox image; its directory name is the image id prefix that
# VERSION/ROOTFS_VERSION in the bundle point at.
if [[ "${HIVE_RELEASE_SKIP_ROOTFS:-}" == "1" ]]; then
  rver=none
elif [[ -n "${HIVE_RELEASE_REUSE_ROOTFS:-}" ]]; then
  # Reuse a rootfs a previous (beta) release already built and tested instead of building it again.
  reuse=$HIVE_RELEASE_REUSE_ROOTFS
  if [[ ! -f "$reuse" ]]; then
    echo "build-release: HIVE_RELEASE_REUSE_ROOTFS=$reuse is not a file" >&2
    exit 1
  fi
  reuse_name=$(basename "$reuse")
  if [[ "$reuse_name" =~ ^hive-rootfs-([0-9a-f]{12})-linux-x86_64\.tar\.gz$ ]]; then
    rver=${BASH_REMATCH[1]}
  else
    echo "build-release: rootfs file name must be hive-rootfs-<12 hex>-linux-x86_64.tar.gz (got \"$reuse_name\")" >&2
    exit 1
  fi
  cp "$reuse" "$out/hive-rootfs-$rver-linux-x86_64.tar.gz"
  reuse_info="$(dirname "$reuse")/rootfs-info.json"
  if [[ ! -f "$reuse_info" ]]; then
    echo "build-release: $reuse_info is missing (it names the image tree the rootfs was built from)" >&2
    exit 1
  fi
  cp "$reuse_info" "$out/rootfs-info.json"
else
  # HIVE_RELEASE_FRESH_ROOTFS=1 rebuilds the image without podman's cache and with a fresh base,
  # so Fedora and Chromium security updates get in. Users then download the new rootfs.
  if [[ "${HIVE_RELEASE_FRESH_ROOTFS:-}" == "1" ]]; then
    npm run build:image:fresh
  else
    npm run build:image
  fi
  npm run build:rootfs
  rootfs=$(realpath "${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive/rootfs/current")
  rver=$(basename "$rootfs")
  # Packed inside podman's rootless user namespace, where this user is root over its own files:
  # the image has files nobody may read (/etc/shadow, setuid sudo), and the archive should record
  # root ownership anyway. /run's contents are left out: the VM's init mounts a fresh tmpfs over
  # /run at boot, and the export can leave unreadable mount points there.
  podman unshare tar -C "$rootfs" --exclude=./.complete --exclude='./run/*' \
    -czf "$out/hive-rootfs-$rver-linux-x86_64.tar.gz" .
  # What the beta channel's rootfs plan compares next time: which image tree this rootfs came from
  # and when it was built. Clients never read it, so it is not in SHA256SUMS.
  image_tree=$(git rev-parse HEAD:image)
  built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"rootfs":"%s","imageTree":"%s","built":"%s"}\n' "$rver" "$image_tree" "$built" > "$out/rootfs-info.json"
fi

app="$stage/hive-$version"
mkdir -p "$app/bin" "$app/lib" "$app/libexec" "$app/ui" "$app/share/licenses/agent-hive"

# libkrun, libkrunfw, the launcher and the static pasta fallback built for old glibc; libkrun
# finds libkrunfw next to itself through its RUNPATH=$ORIGIN. Licenses ship beside the binaries.
cp "$native/lib/libkrun.so.1" "$app/lib/libkrun.so.1"
cp "$native/lib/libkrunfw.so.5" "$app/lib/libkrunfw.so.5"
cp "$native/libexec/hive-vm" "$app/libexec/hive-vm"
cp "$native/libexec/pasta" "$app/libexec/pasta"
if [[ -f "$native/libexec/pasta.avx2" ]]; then cp "$native/libexec/pasta.avx2" "$app/libexec/pasta.avx2"; fi
cp -R "$native/share/licenses/." "$app/share/licenses/"
cp LICENSE "$app/share/licenses/agent-hive/LICENSE"

# The web UI's files, next to lib/: bin/hive sets HIVE_BUNDLE_ROOT, and index.ts finds
# <bundle>/ui/dist from it.
cp -R ui/dist "$app/ui/dist"

cat > "$app/bin/hive" <<'EOF'
#!/bin/sh
root=$(dirname "$(dirname "$(readlink -f "$0")")")
HIVE_BUNDLE_ROOT=$root exec "$root/libexec/node" "$root/lib/hive.mjs" "$@"
EOF
chmod 755 "$app/bin/hive"

npx esbuild dist/cli.js --bundle --platform=node --format=esm --target=node24 --outfile="$app/lib/hive.mjs" --banner:js="import { createRequire as __hiveRequire } from 'node:module'; const require = __hiveRequire(import.meta.url);"

# The bundle ships its own Node, checked against the SHASUMS256.txt from nodejs.org.
curl -fsSL -o "$stage/node-v$NODE_VERSION-linux-x64.tar.gz" \
  "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz"
curl -fsSL -o "$stage/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
(cd "$stage" && grep " node-v$NODE_VERSION-linux-x64.tar.gz\$" SHASUMS256.txt | sha256sum -c -)
tar -xzf "$stage/node-v$NODE_VERSION-linux-x64.tar.gz" -C "$stage" "node-v$NODE_VERSION-linux-x64/bin/node"
cp "$stage/node-v$NODE_VERSION-linux-x64/bin/node" "$app/libexec/node"
chmod 755 "$app/libexec/node"

echo "$version" > "$app/VERSION"
echo "$rver" > "$app/ROOTFS_VERSION"

tar -C "$stage" -czf "$out/hive-$version-linux-x86_64.tar.gz" "hive-$version"

# libkrunfw contains the Linux kernel (GPL-2.0), so the release also publishes the corresponding
# source: libkrunfw at the pinned tag, and the kernel tarball its Makefile builds from. The static
# pasta fallback is built from the pinned passt source, so that tarball is published too.
libkrunfw_version=$(node -p "require('./versions.json').libkrunfw.version")
libkrunfw_source=$(node -p "require('./versions.json').libkrunfw.source")
passt_version=$(node -p "require('./versions.json').passt.version")
passt_sha256=$(node -p "require('./versions.json').passt.sha256")
if [[ "${HIVE_RELEASE_SKIP_SOURCES:-}" == "1" ]]; then
  echo "build-release: skipping the GPL source assets (HIVE_RELEASE_SKIP_SOURCES=1)"
else
  curl -fsSL -o "$out/libkrunfw-$libkrunfw_version-source.tar.gz" "$libkrunfw_source"
  makefile=$(tar -tzf "$out/libkrunfw-$libkrunfw_version-source.tar.gz" | grep -E '^[^/]+/Makefile$' | head -n1)
  if [[ -z "$makefile" ]]; then
    echo "build-release: no Makefile in $libkrunfw_source" >&2
    exit 1
  fi
  # Where libkrunfw's Makefile downloads its kernel source from, asked of make itself: the layout
  # changes between libkrunfw versions (a kernel.org tarball plus patches/, or a patched fork).
  srcdir=$(mktemp -d)
  tar -xzf "$out/libkrunfw-$libkrunfw_version-source.tar.gz" -C "$srcdir" "$makefile"
  kernel_remote=$(make -s -C "$srcdir/$(dirname "$makefile")" \
    --eval 'hive-print-kernel-remote: ; @echo $(KERNEL_REMOTE)' hive-print-kernel-remote)
  rm -rf "$srcdir"
  if [[ "$kernel_remote" != https://* ]]; then
    echo "build-release: could not read KERNEL_REMOTE from $makefile (got \"$kernel_remote\")" >&2
    exit 1
  fi
  kernel_file=$(basename "$kernel_remote")
  curl -fsSL -o "$out/kernel-source-$kernel_file" "$kernel_remote"
  # passt: build-native.sh kept the SHA-256 verified tarball it built pasta from; check it once
  # more on the way out, then publish it as the corresponding source.
  passt_source="$native/passt-$passt_version-source.tar.xz"
  if [[ ! -f "$passt_source" ]]; then
    echo "build-release: $passt_source is missing; rebuild with scripts/build-native.sh --force" >&2
    exit 1
  fi
  actual=$(sha256sum "$passt_source" | cut -d' ' -f1)
  if [[ "$actual" != "$passt_sha256" ]]; then
    echo "build-release: passt source checksum mismatch: expected $passt_sha256, got $actual" >&2
    exit 1
  fi
  cp "$passt_source" "$out/passt-$passt_version-source.tar.xz"
fi

(cd "$out" && sha256sum hive-*.tar.gz > SHA256SUMS)
if [[ "${HIVE_RELEASE_SKIP_SOURCES:-}" != "1" ]]; then
  (cd "$out" && sha256sum libkrunfw-*-source.tar.gz kernel-source-* passt-*-source.tar.xz >> SHA256SUMS)
fi
node scripts/sign.mjs "$key" "$out/SHA256SUMS"

ls -l "$out"
