#!/bin/sh
# install-cli.sh - install the latest Agent Hive CLI release.
#
# Downloads over HTTPS and checks the download against the release's SHA256SUMS, so a corrupted
# or truncated download is rejected. `hive update` additionally verifies the release's ed25519
# signature before switching versions.
set -eu

REPO=${HIVE_RELEASE_REPO:-ogsapps/agent-hive}
API=${HIVE_RELEASE_API:-https://api.github.com}

if [ "$(uname -m)" != "x86_64" ]; then
  echo "hive: only linux x86_64 releases exist for now" >&2
  exit 1
fi

missing=
for bin in curl tar sha256sum; do
  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
done
if [ -n "$missing" ]; then
  echo "hive: missing required command(s):$missing" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$API/repos/$REPO/releases/latest" -o "$tmp/release.json"

ver=$(sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' "$tmp/release.json" | head -n 1)
if [ -z "$ver" ]; then
  echo "hive: no latest release found for $REPO" >&2
  exit 1
fi

urls=$(grep -o '"browser_download_url": *"[^"]*"' "$tmp/release.json" | sed 's/.*"\(https[^"]*\)"/\1/')
sums_url=$(printf '%s\n' "$urls" | grep '/SHA256SUMS$' | head -n 1)
app_url=$(printf '%s\n' "$urls" | grep "/hive-$ver-linux-x86_64.tar.gz$" | head -n 1)
if [ -z "$sums_url" ] || [ -z "$app_url" ]; then
  echo "hive: release v$ver has no linux x86_64 build" >&2
  exit 1
fi

curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS"
curl -fsSL "$app_url" -o "$tmp/hive-$ver-linux-x86_64.tar.gz"
(cd "$tmp" && grep " hive-$ver-linux-x86_64.tar.gz\$" SHA256SUMS | sha256sum -c -)

data=${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive
tar -xzf "$tmp/hive-$ver-linux-x86_64.tar.gz" -C "$tmp"
mkdir -p "$data/versions"
if [ ! -d "$data/versions/$ver" ]; then
  mv "$tmp/hive-$ver" "$data/versions/$ver"
fi

ln -sfn "$data/versions/$ver" "$data/current"
mkdir -p "$HOME/.local/bin"
ln -sfn "$data/current/bin/hive" "$HOME/.local/bin/hive"

"$data/current/bin/hive" setup || true

echo "hive $ver installed; make sure $HOME/.local/bin is on your PATH"
