#!/usr/bin/env bash
# Build a signed Agent Hive release: an app bundle with Node, the bundled CLI and the VM
# launcher, plus the VM rootfs as a separate download. Run from the repo root (or via
# `npm run release`). Needs the release signing key; see docs/RELEASING.md.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

version=$(node -p "require('./package.json').version")
NODE_VERSION=${HIVE_NODE_VERSION:-24.18.0}
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
npm run build:vm

# The rootfs is exported from the sandbox image; its directory name is the image id prefix that
# VERSION/ROOTFS_VERSION in the bundle point at.
if [[ "${HIVE_RELEASE_SKIP_ROOTFS:-}" == "1" ]]; then
  rver=none
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
fi

app="$stage/hive-$version"
mkdir -p "$app/bin" "$app/lib" "$app/libexec" "$app/ui"

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

cp vm/hive-vm "$app/libexec/hive-vm"
chmod 755 "$app/libexec/hive-vm"

echo "$version" > "$app/VERSION"
echo "$rver" > "$app/ROOTFS_VERSION"

tar -C "$stage" -czf "$out/hive-$version-linux-x86_64.tar.gz" "hive-$version"

(cd "$out" && sha256sum hive-*.tar.gz > SHA256SUMS)
node scripts/sign.mjs "$key" "$out/SHA256SUMS"

ls -l "$out"
