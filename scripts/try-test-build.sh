#!/usr/bin/env bash
# try-test-build.sh - run a test build of Agent Hive without installing it.
#
# A test build is the prerelease tagged `test-<run>-<version>` that test.yml publishes on every
# push to main. This script downloads the newest one (or a tag you name) from GitHub, checks every
# file against the release's SHA256SUMS, extracts it under the user's cache directory (a VM
# filesystem is about 1.6 GB extracted, too big for a small tmpfs /tmp) and prints how to run it.
# Test builds are unsigned: the checksum fetched over HTTPS is the only integrity check, and
# `hive update` deliberately never installs them.
set -euo pipefail

REPO=${HIVE_RELEASE_REPO:-Old-GenS/agent-hive}
API=${HIVE_RELEASE_API:-https://api.github.com}
C=${HIVE_TEST_BUILDS:-${XDG_CACHE_HOME:-$HOME/.cache}/agent-hive/test-builds}
DATA=${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive
MIN_FREE_MB=${HIVE_TEST_BUILDS_MIN_FREE_MB:-4096}

TAG_RE='^test-[0-9]+-[0-9]+\.[0-9]+\.[0-9]+$'

usage() {
  cat <<'EOF'
usage: try-test-build.sh [<tag>] [-- <hive args>...]
       try-test-build.sh --list
       try-test-build.sh --clean

Download a test build of Agent Hive, check it against the release's SHA256SUMS, extract it under
HIVE_TEST_BUILDS (default ~/.cache/agent-hive/test-builds) and print how to run it.

  <tag>            a test build tag (test-<run>-<version>); the newest when omitted
  -- <hive args>   run the build instead of only printing the commands
  --list           list test builds, newest first
  --clean          remove the cache directory

environment: HIVE_RELEASE_REPO, HIVE_RELEASE_API, HIVE_TEST_BUILDS,
             HIVE_TEST_BUILDS_MIN_FREE_MB, GH_TOKEN or GITHUB_TOKEN
EOF
}

mode=print
tag=
hive_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --list)
      mode=list
      shift
      ;;
    --clean)
      mode=clean
      shift
      ;;
    --)
      shift
      hive_args=("$@")
      mode=run
      break
      ;;
    -*)
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$tag" ]; then
        usage >&2
        exit 2
      fi
      tag=$1
      shift
      ;;
  esac
done

if [ "$mode" != print ] && [ "$mode" != run ]; then
  if [ -n "$tag" ] || [ ${#hive_args[@]} -ne 0 ]; then
    usage >&2
    exit 2
  fi
fi

# A named tag is checked before any network request, so a typo fails fast and offline.
if [ -n "$tag" ] && ! [[ "$tag" =~ $TAG_RE ]]; then
  echo "$tag is not a test build tag (test-<run>-<version>)" >&2
  exit 2
fi

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "test builds are Linux x86_64 only" >&2
  exit 1
fi

for bin in curl tar sha256sum node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing required command: $bin" >&2
    exit 1
  fi
done

if [ "$mode" = clean ]; then
  rm -rf -- "$C"
  echo "removed $C"
  exit 0
fi

AUTH=()
if [ -n "${GH_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer $GH_TOKEN")
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi

mkdir -p "$C"
C=$(cd -- "$C" && pwd)
TMP=$(mktemp -d "$C/.dl.XXXXXX")
trap 'rm -rf -- "$TMP"' EXIT

# Releases, newest first, as `<tag>\t<created_at>` lines from the GitHub API JSON.
release_lines() {
  node -e '
const fs = require("fs");
const rels = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const list = rels
  .filter((rel) => rel && typeof rel.tag_name === "string" && rel.tag_name.startsWith("test-"))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
for (const rel of list) process.stdout.write(rel.tag_name + "\t" + (rel.created_at || "") + "\n");
' "$1"
}

if [ "$mode" = list ]; then
  curl -fsSL ${AUTH[@]+"${AUTH[@]}"} \
    "$API/repos/$REPO/releases?per_page=100" -o "$TMP/releases.json"
  found=0
  while IFS=$'\t' read -r release_tag created; do
    [ -n "$release_tag" ] || continue
    found=1
    line="$release_tag  $created"
    rest=${release_tag#test-}
    version_part=${rest#*-}
    if [ -f "$C/$release_tag/hive-$version_part/VERSION" ]; then
      line="$line  (cached)"
    fi
    printf '%s\n' "$line"
  done < <(release_lines "$TMP/releases.json")
  if [ "$found" = 0 ]; then
    echo "no test builds on $REPO" >&2
    exit 1
  fi
  exit 0
fi

if [ -z "$tag" ]; then
  curl -fsSL ${AUTH[@]+"${AUTH[@]}"} \
    "$API/repos/$REPO/releases?per_page=100" -o "$TMP/releases.json"
  # Read only the first line, without a `| head` whose early close would EPIPE node under pipefail.
  while IFS=$'\t' read -r first_tag _; do
    tag=$first_tag
    break
  done < <(release_lines "$TMP/releases.json")
  if [ -z "$tag" ]; then
    echo "no test builds on $REPO" >&2
    exit 1
  fi
fi

curl -fsSL ${AUTH[@]+"${AUTH[@]}"} \
  "$API/repos/$REPO/releases/tags/$tag" -o "$TMP/release.json"

# Pick the app, the VM filesystem and SHA256SUMS out of the release JSON. Only node parses JSON.
app_name=
app_url=
rootfs_name=
rootfs_url=
sums_url=
version=
rootfs_id=
commit=
while IFS=$'\t' read -r kind name url size; do
  case "$kind" in
    app)
      app_name=$name
      app_url=$url
      ;;
    rootfs)
      rootfs_name=$name
      rootfs_url=$url
      ;;
    sums)
      sums_url=$url
      ;;
    meta)
      version=$name
      rootfs_id=$url
      commit=$size
      ;;
  esac
done < <(node -e '
const fs = require("fs");
const rel = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const appRe = /^hive-([0-9][^-]*)-linux-x86_64\.tar\.gz$/;
const rootfsRe = /^hive-rootfs-([0-9a-f]{12})-linux-x86_64\.tar\.gz$/;
const assets = Array.isArray(rel.assets) ? rel.assets : [];
let app = "";
let rootfs = "";
let sums = "";
let version = "";
let rootfsId = "";
for (const asset of assets) {
  if (!asset || typeof asset.name !== "string") continue;
  let match;
  if ((match = appRe.exec(asset.name))) {
    version = match[1];
    app = "app\t" + asset.name + "\t" + asset.browser_download_url + "\t" + asset.size + "\n";
  } else if ((match = rootfsRe.exec(asset.name))) {
    rootfsId = match[1];
    rootfs = "rootfs\t" + asset.name + "\t" + asset.browser_download_url + "\t" + asset.size + "\n";
  } else if (asset.name === "SHA256SUMS") {
    sums = "sums\t" + asset.name + "\t" + asset.browser_download_url + "\t" + asset.size + "\n";
  }
}
process.stdout.write(app + rootfs + sums);
process.stdout.write("meta\t" + version + "\t" + rootfsId + "\t" + (rel.target_commitish || "") + "\n");
' "$TMP/release.json")

if [ -z "$app_name" ]; then
  echo "release $tag has no app build (hive-<version>-linux-x86_64.tar.gz)" >&2
  exit 1
fi
if [ -z "$rootfs_name" ]; then
  echo "release $tag has no VM filesystem (hive-rootfs-<id>-linux-x86_64.tar.gz)" >&2
  exit 1
fi
if [ -z "$sums_url" ]; then
  echo "release $tag has no SHA256SUMS" >&2
  exit 1
fi

bundle="$C/$tag/hive-$version"
need_app=1
if [ -f "$bundle/VERSION" ]; then
  need_app=0
fi

if [ -f "$DATA/rootfs/$rootfs_id/.complete" ]; then
  rootfs_source="from your hive install"
  rootfs="$DATA/rootfs/$rootfs_id"
  need_rootfs=0
elif [ -f "$C/rootfs/$rootfs_id/.complete" ]; then
  rootfs_source="cached"
  rootfs="$C/rootfs/$rootfs_id"
  need_rootfs=0
else
  rootfs_source="downloaded"
  rootfs="$C/rootfs/$rootfs_id"
  need_rootfs=1
fi

if [ "$need_app" = 1 ] || [ "$need_rootfs" = 1 ]; then
  if [ "$need_rootfs" = 1 ]; then
    need_mb=$MIN_FREE_MB
  else
    need_mb=512
  fi
  free_kb=$(df -Pk "$C" | awk 'NR == 2 { print $4 }')
  free_mb=$((free_kb / 1024))
  if [ "$free_kb" -lt $((need_mb * 1024)) ]; then
    echo "not enough space in $C: $free_mb MB free, $need_mb MB needed" >&2
    echo "set HIVE_TEST_BUILDS to a directory with more space" >&2
    exit 1
  fi
fi

# Downloads land in the temporary directory; nothing enters its destination until it has been
# checked against SHA256SUMS.
curl -fsSL -o "$TMP/SHA256SUMS" "$sums_url"
if [ "$need_app" = 1 ]; then
  curl -fL --retry 3 -o "$TMP/$app_name" "$app_url"
fi
if [ "$need_rootfs" = 1 ]; then
  curl -fL --retry 3 -o "$TMP/$rootfs_name" "$rootfs_url"
fi

check_asset() {
  local name=$1
  local expected actual
  expected=$(awk -v n="$name" '$2 == n { print $1; exit }' "$TMP/SHA256SUMS")
  if [ -z "$expected" ]; then
    echo "$name is not in SHA256SUMS" >&2
    exit 1
  fi
  actual=$(sha256sum "$TMP/$name" | awk '{ print $1 }')
  if [ "$actual" != "$expected" ]; then
    echo "checksum mismatch: $name" >&2
    exit 1
  fi
}

if [ "$need_app" = 1 ]; then
  check_asset "$app_name"
fi
if [ "$need_rootfs" = 1 ]; then
  check_asset "$rootfs_name"
fi

if [ "$need_app" = 1 ]; then
  tar -xzf "$TMP/$app_name" -C "$TMP"
  mkdir -p "$C/$tag"
  rm -rf -- "$C/$tag/hive-$version"
  mv "$TMP/hive-$version" "$C/$tag/"
fi

if [ "$need_rootfs" = 1 ]; then
  mkdir -p "$C/rootfs"
  rm -rf -- "$C/rootfs/$rootfs_id.partial"
  mkdir -p "$C/rootfs/$rootfs_id.partial"
  tar -xzf "$TMP/$rootfs_name" --no-same-owner -C "$C/rootfs/$rootfs_id.partial"
  touch "$C/rootfs/$rootfs_id.partial/.complete"
  rm -rf -- "$C/rootfs/$rootfs_id"
  mv "$C/rootfs/$rootfs_id.partial" "$C/rootfs/$rootfs_id"
fi

print_summary() {
  cat <<EOF
test build: $tag (v$version, commit $commit)
bundle: $bundle
VM filesystem: $rootfs_id ($rootfs_source) at $rootfs

Run the test build:
  HIVE_ROOTFS=$rootfs $bundle/bin/hive run "<prompt>"
Use its VM filesystem with a source build (only while your branch has not changed image/):
  HIVE_ROOTFS=$rootfs hive run "<prompt>"
EOF
}

if [ "$mode" = run ]; then
  print_summary >&2
  # exec replaces this shell, so remove the download directory before the EXIT trap is lost.
  rm -rf -- "$TMP"
  trap - EXIT
  export HIVE_ROOTFS="$rootfs"
  exec "$bundle/bin/hive" ${hive_args[@]+"${hive_args[@]}"}
fi

print_summary
