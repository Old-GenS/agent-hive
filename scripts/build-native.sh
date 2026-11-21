#!/usr/bin/env bash
# Build the release-grade native pieces: libkrun (from source, old-glibc), libkrunfw (upstream's
# prebuilt kernel library, checked against a pinned SHA-256) and the hardened hive-vm launcher.
#
# The launcher and libkrun are compiled inside the pinned manylinux_2_28 container so they run on
# older distros, and the container refuses output that needs newer glibc symbols or unexpected
# libraries. Output goes to build/native/ and is reused while versions.json and vm/hive-vm.c are
# unchanged; pass --force to rebuild anyway. Runs from any cwd.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root=$(pwd)
out="$root/build/native"
force=false
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    -*)
      echo "build-native: unknown option \"$arg\"" >&2
      exit 2
      ;;
    *)
      echo "build-native: unexpected argument \"$arg\"" >&2
      exit 2
      ;;
  esac
done

# Read one pin from versions.json without jq: read_pin libkrunfw sha256.
read_pin() {
  node -e '
    const { readFileSync } = require("node:fs");
    let at = JSON.parse(readFileSync(process.argv[1], "utf8"));
    for (const key of process.argv.slice(2)) at = at[key];
    if (at === undefined) {
      console.error(`missing pin ${process.argv.slice(2).join(".")} in versions.json`);
      process.exit(1);
    }
    process.stdout.write(String(at));
  ' "$root/versions.json" "$@"
}

libkrun_repo=$(read_pin libkrun repo)
libkrun_tag=$(read_pin libkrun tag)
libkrun_commit=$(read_pin libkrun commit)
libkrunfw_version=$(read_pin libkrunfw version)
libkrunfw_url=$(read_pin libkrunfw url)
libkrunfw_sha256=$(read_pin libkrunfw sha256)
libkrunfw_source=$(read_pin libkrunfw source)
rust_version=$(read_pin rust)
build_image=$(read_pin buildImage)

# The stamp covers the pins and the launcher source: when either changes, rebuild.
stamp=$(cd "$root" && sha256sum versions.json vm/hive-vm.c)
if [[ "$force" == false && -f "$out/STAMP" && "$(cat "$out/STAMP")" == "$stamp" ]]; then
  echo "build/native is up to date"
  echo "$out"
  exit 0
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "build-native: podman is required" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# libkrunfw: upstream's prebuilt guest kernel, verified against the pinned SHA-256. It depends on
# nothing, not even glibc, so it is copied in as is.
echo "build-native: downloading libkrunfw $libkrunfw_version" >&2
curl -fsSL -o "$tmp/libkrunfw.tgz" "$libkrunfw_url"
if ! printf '%s  %s\n' "$libkrunfw_sha256" "$tmp/libkrunfw.tgz" | sha256sum -c - >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/libkrunfw.tgz" | cut -d' ' -f1)
  echo "build-native: libkrunfw checksum mismatch: expected $libkrunfw_sha256, got $actual" >&2
  exit 1
fi
mkdir -p "$tmp/libkrunfw"
tar -xzf "$tmp/libkrunfw.tgz" -C "$tmp/libkrunfw"
libkrunfw_so="$tmp/libkrunfw/lib/x86_64-linux-gnu/libkrunfw.so.$libkrunfw_version"
if [[ ! -f "$libkrunfw_so" ]]; then
  echo "build-native: $libkrunfw_url has no lib/x86_64-linux-gnu/libkrunfw.so.$libkrunfw_version" >&2
  exit 1
fi

# libkrunfw's own license files: every top-level LICENSE* or COPYING* file in its source tarball.
echo "build-native: downloading libkrunfw source for its licenses" >&2
curl -fsSL -o "$tmp/libkrunfw-source.tar.gz" "$libkrunfw_source"
mkdir -p "$tmp/libkrunfw-source"
tar -xzf "$tmp/libkrunfw-source.tar.gz" -C "$tmp/libkrunfw-source"
mkdir -p "$tmp/licenses/libkrunfw"
shopt -s nullglob
license_files=("$tmp/libkrunfw-source"/*/LICENSE* "$tmp/libkrunfw-source"/*/COPYING*
  "$tmp/libkrunfw-source"/LICENSE* "$tmp/libkrunfw-source"/COPYING*)
if [[ ${#license_files[@]} -eq 0 ]]; then
  echo "build-native: no LICENSE or COPYING file in $libkrunfw_source" >&2
  exit 1
fi
for file in "${license_files[@]}"; do
  cp -p "$file" "$tmp/licenses/libkrunfw/"
done

# The container build: the repo is mounted read-only at /src and a fresh output dir at /out. The
# container writes lib/, libexec/ and libkrun's licenses; the launcher is compiled there too.
echo "build-native: building libkrun $libkrun_tag and hive-vm in $build_image" >&2
mkdir -p "$tmp/out"
podman run --rm --security-opt label=disable \
  -v "$root:/src:ro" \
  -v "$tmp/out:/out" \
  -e LIBKRUN_REPO="$libkrun_repo" \
  -e LIBKRUN_TAG="$libkrun_tag" \
  -e LIBKRUN_COMMIT="$libkrun_commit" \
  -e RUST_VERSION="$rust_version" \
  "$build_image" \
  bash /src/scripts/native-in-container.sh

# Assemble the final tree in a staging dir, so a failure never leaves a half-replaced build/native.
staging="$tmp/native"
mkdir -p "$staging/lib" "$staging/libexec" "$staging/share/licenses"
cp -a "$tmp/out/lib/." "$staging/lib/"
cp -a "$tmp/out/libexec/." "$staging/libexec/"
cp -a "$tmp/out/share/licenses/." "$staging/share/licenses/"
install -m 755 "$libkrunfw_so" "$staging/lib/libkrunfw.so.5"
mkdir -p "$staging/share/licenses/libkrunfw"
for file in "$tmp/licenses/libkrunfw/"*; do
  install -m 644 "$file" "$staging/share/licenses/libkrunfw/"
done

mkdir -p "$root/build"
rm -rf "$out"
mv "$staging" "$out"

# The stamp goes in last: it says this build matches the pins and the launcher source.
printf '%s\n' "$stamp" > "$out/STAMP"

echo "$out"
