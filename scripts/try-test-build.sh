#!/usr/bin/env bash
# try-test-build.sh - run a test build of Agent Hive without installing it.
#
# A test build is the prerelease tagged `test-<run>-<version>` that test.yml publishes on every
# push to main. This script downloads the newest one (or a tag you name) from GitHub, checks every
# file against the release's SHA256SUMS, extracts it under the user's cache directory (a VM
# filesystem is about 1.6 GB extracted, too big for a small tmpfs /tmp) and prints how to run it.
# Test builds are unsigned: the checksum fetched over HTTPS is the only integrity check, and
# `hive update` deliberately never installs them.
#
# `--serve` instead runs the build's server (`hive serve`) in a home of its own: $HIVE_TEST_SERVE_HOME
# (default $HIVE_TEST_BUILDS/serve) is the config, data and cache directory, so the staging server
# never sees the real install's keys, runs or settings. It reports itself as a test build
# (HIVE_BUILD_CHANNEL/HIVE_BUILD_LABEL), and scripts/test-server.sh keeps that server running and
# updates it to a newer test build when one appears.
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
       try-test-build.sh [<tag>] --serve [--port <n>] [--host <addr>] [--fresh]
       try-test-build.sh --list
       try-test-build.sh --clean

Download a test build of Agent Hive, check it against the release's SHA256SUMS, extract it under
HIVE_TEST_BUILDS (default ~/.cache/agent-hive/test-builds) and print how to run it.

  <tag>            a test build tag (test-<run>-<version>); the newest when omitted
  -- <hive args>   run the build instead of only printing the commands
  --list           list test builds, newest first
  --clean          remove the cache directory
  --serve          run the build's server in an isolated home instead of printing commands
  --port <n>       with --serve: the port to listen on (default: the first free one from 8081)
  --host <addr>    with --serve: the address to listen on (default 127.0.0.1)
  --fresh          with --serve: delete the serve home first (a clean staging server)

environment: HIVE_RELEASE_REPO, HIVE_RELEASE_API, HIVE_TEST_BUILDS,
             HIVE_TEST_BUILDS_MIN_FREE_MB, HIVE_TEST_SERVE_HOME, HIVE_TEST_SERVE_PORT,
             GH_TOKEN or GITHUB_TOKEN
EOF
}

mode=print
serve=0
port_arg=
host_arg=
fresh=0
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
    --serve)
      serve=1
      shift
      ;;
    --port)
      if [ $# -lt 2 ]; then
        usage >&2
        exit 2
      fi
      port_arg=$2
      shift 2
      ;;
    --host)
      if [ $# -lt 2 ]; then
        usage >&2
        exit 2
      fi
      host_arg=$2
      shift 2
      ;;
    --fresh)
      fresh=1
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

# --port, --host and --fresh only mean something with --serve, which is a mode of its own.
if [ "$serve" = 1 ]; then
  if [ "$mode" != print ]; then
    usage >&2
    exit 2
  fi
  mode=serve
elif [ -n "$port_arg" ] || [ -n "$host_arg" ] || [ "$fresh" = 1 ]; then
  usage >&2
  exit 2
fi

if [ "$mode" = list ] || [ "$mode" = clean ]; then
  if [ -n "$tag" ] || [ ${#hive_args[@]} -ne 0 ]; then
    usage >&2
    exit 2
  fi
fi

if [ -n "$port_arg" ] && ! [[ "$port_arg" =~ ^[0-9]+$ ]]; then
  usage >&2
  exit 2
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

# ── serve mode: an isolated home and a port, chosen before any network request ──
if [ "$mode" = serve ]; then
  S=${HIVE_TEST_SERVE_HOME:-$C/serve}
  if [ "$fresh" = 1 ]; then
    rm -rf -- "$S"
  fi
  mkdir -p "$S/config" "$S/data" "$S/cache"
  S=$(cd -- "$S" && pwd)

  # A port is free when nothing accepts a connection to it on loopback. bash's /dev/tcp is the
  # probe, so no extra tool is needed.
  port_free() {
    if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
      return 1
    fi
    return 0
  }

  if [ -n "$port_arg" ]; then
    if ! port_free "$port_arg"; then
      echo "port $port_arg is in use" >&2
      exit 1
    fi
    port=$port_arg
  else
    first_port=${HIVE_TEST_SERVE_PORT:-8081}
    if ! [[ "$first_port" =~ ^[0-9]+$ ]]; then
      echo "HIVE_TEST_SERVE_PORT is not a port number: $first_port" >&2
      exit 1
    fi
    last_port=$((first_port + 20))
    port=
    candidate=$first_port
    while [ "$candidate" -le "$last_port" ]; do
      if port_free "$candidate"; then
        port=$candidate
        break
      fi
      candidate=$((candidate + 1))
    done
    if [ -z "$port" ]; then
      echo "no free port in $first_port-$last_port" >&2
      exit 1
    fi
  fi
  host=${host_arg:-127.0.0.1}
fi

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

# Whether this run serves from cache because GitHub did not answer (serve mode only).
offline=0
commit=

if [ -z "$tag" ]; then
  if ! curl -fsSL ${AUTH[@]+"${AUTH[@]}"} \
      "$API/repos/$REPO/releases?per_page=100" -o "$TMP/releases.json"; then
    # Serve mode can fall back to the build it is already running: a staging server should keep
    # serving when GitHub is unreachable, as long as that build's bundle is in the cache.
    cached_tag=
    if [ "$mode" = serve ] && [ -f "$S/current" ]; then
      cached_tag=$(head -n 1 "$S/current" || true)
      if [ -n "$cached_tag" ] && [[ "$cached_tag" =~ $TAG_RE ]]; then
        cached_version=${cached_tag#test-}
        cached_version=${cached_version#*-}
        if [ ! -f "$C/$cached_tag/hive-$cached_version/VERSION" ]; then
          cached_tag=
        fi
      else
        cached_tag=
      fi
    fi
    if [ -z "$cached_tag" ]; then
      echo "could not reach GitHub to list test builds" >&2
      exit 1
    fi
    tag=$cached_tag
    offline=1
    echo "GitHub unreachable; serving cached $tag" >&2
  fi
  if [ "$offline" = 0 ]; then
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
fi

# Offline (serve mode): no release JSON and no SHA256SUMS to check against, so the bundle and the
# VM filesystem it names must already be on disk; the cached build is served as it is.
if [ "$offline" = 1 ]; then
  version=${tag#test-}
  version=${version#*-}
  bundle="$C/$tag/hive-$version"
  rootfs_id=
  if [ -f "$bundle/ROOTFS_VERSION" ]; then
    rootfs_id=$(head -n 1 "$bundle/ROOTFS_VERSION" | tr -d '[:space:]')
  fi
  if [ -z "$rootfs_id" ]; then
    echo "cannot serve cached $tag: its bundle has no ROOTFS_VERSION" >&2
    exit 1
  fi
  if [ -f "$DATA/rootfs/$rootfs_id/.complete" ]; then
    rootfs_source="from your hive install"
    rootfs="$DATA/rootfs/$rootfs_id"
  elif [ -f "$C/rootfs/$rootfs_id/.complete" ]; then
    rootfs_source="cached"
    rootfs="$C/rootfs/$rootfs_id"
  else
    echo "cannot serve cached $tag: VM filesystem $rootfs_id is not cached" >&2
    exit 1
  fi
else
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

if [ "$mode" = serve ]; then
  # The tag this home is serving; the update check and the offline fallback read it.
  current_tmp=$(mktemp "$S/.current.XXXXXX")
  printf '%s\n' "$tag" >"$current_tmp"
  mv "$current_tmp" "$S/current"

  # What the web UI shows in its banner: the tag, and the commit when we learned it (a cached
  # offline serve only knows the tag).
  label=$tag
  if [ -n "$commit" ]; then
    label="$tag · ${commit:0:7}"
  fi

  echo "serving $tag on http://$host:$port/ui/ (isolated home: $S)" >&2
  echo "log in with API_TOKEN from $S/config/agent-hive/env" >&2

  # exec replaces this shell, so remove the download directory before the EXIT trap is lost.
  rm -rf -- "$TMP"
  trap - EXIT
  cd "$S"

  # A minimal environment: the server's own variables only. Nothing from this shell (a provider
  # key, a GitHub token) may reach the staging server's process.
  env_args=()
  for name in HOME PATH USER LOGNAME LANG TERM XDG_RUNTIME_DIR; do
    if [ -n "${!name:-}" ]; then
      env_args+=("$name=${!name}")
    fi
  done
  env_args+=(
    "XDG_CONFIG_HOME=$S/config"
    "XDG_DATA_HOME=$S/data"
    "XDG_CACHE_HOME=$S/cache"
    "HIVE_ROOTFS=$rootfs"
    "PORT=$port"
    "HOST=$host"
    "HIVE_BUILD_CHANNEL=test"
    "HIVE_BUILD_LABEL=$label"
  )
  exec env -i "${env_args[@]}" "$bundle/bin/hive" serve
fi

if [ "$mode" = run ]; then
  print_summary >&2
  # exec replaces this shell, so remove the download directory before the EXIT trap is lost.
  rm -rf -- "$TMP"
  trap - EXIT
  export HIVE_ROOTFS="$rootfs"
  exec "$bundle/bin/hive" ${hive_args[@]+"${hive_args[@]}"}
fi

print_summary
