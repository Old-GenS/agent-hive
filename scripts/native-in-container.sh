#!/usr/bin/env bash
# Runs inside the pinned manylinux_2_28 container (as root) as part of scripts/build-native.sh.
# Builds libkrun from source at the pinned tag and compiles the hardened hive-vm launcher, then
# refuses output that needs a newer glibc or unexpected shared libraries. Writes only under /out.
#
# Environment: LIBKRUN_REPO, LIBKRUN_TAG, LIBKRUN_COMMIT and RUST_VERSION come from versions.json.
set -euo pipefail

: "${LIBKRUN_REPO:?LIBKRUN_REPO is required}"
: "${LIBKRUN_TAG:?LIBKRUN_TAG is required}"
: "${LIBKRUN_COMMIT:?LIBKRUN_COMMIT is required}"
: "${RUST_VERSION:?RUST_VERSION is required}"

fail() {
  echo "native-in-container: $*" >&2
  exit 1
}

# The oldest glibc the old-glibc build may use (manylinux_2_28's baseline).
min_glibc=2.28
# Every shared library the packaged files may need; anything else means the build picked up a
# dependency from the container that the user may not have.
allowed_needed="libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 librt.so.1 libgcc_s.so.1 ld-linux-x86-64.so.2"

# ---- build tools --------------------------------------------------------------------------
# glibc-static carries the static libc that libkrun's init blob needs. On AlmaLinux 8 it lives in
# powertools; older/newer layouts call the same repo crb, so enable whichever exists.
echo "native-in-container: installing build tools"
repo_args=()
if ! dnf -q list --available glibc-static >/dev/null 2>&1; then
  for candidate in powertools crb; do
    if dnf -q repolist --all 2>/dev/null | awk '{ print $1 }' | grep -qx "$candidate"; then
      repo_args=(--enablerepo "$candidate")
      echo "native-in-container: enabling the $candidate repo for glibc-static"
      break
    fi
  done
fi
# clang-devel: libkrun's build runs bindgen, which needs libclang.
dnf install -y "${repo_args[@]}" glibc-static git patchelf binutils clang-devel

# ---- Rust ---------------------------------------------------------------------------------
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION"
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"
rustc --version
cargo --version

# ---- libkrun ------------------------------------------------------------------------------
rm -rf /tmp/libkrun
git clone --depth 1 --branch "$LIBKRUN_TAG" "$LIBKRUN_REPO" /tmp/libkrun
head=$(git -C /tmp/libkrun rev-parse HEAD)
if [[ "$head" != "$LIBKRUN_COMMIT" ]]; then
  fail "libkrun $LIBKRUN_TAG is commit $head, expected $LIBKRUN_COMMIT"
fi

# Default features only: no GPU, sound, BLK, NET, SEV or TDX, so the result needs just libc.
make -C /tmp/libkrun

full_version=$(sed -n 's/^FULL_VERSION=//p' /tmp/libkrun/Makefile | head -n1)
if [[ -z "$full_version" ]]; then
  fail "could not read FULL_VERSION from /tmp/libkrun/Makefile"
fi
built="/tmp/libkrun/target/release/libkrun.so.$full_version"
if [[ ! -f "$built" || -L "$built" ]]; then
  fail "$built is missing or not a regular file"
fi

mkdir -p /out/lib /out/libexec /out/share/licenses/libkrun
# The .so.1 name is the ABI version; carry RUNPATH=$ORIGIN so it finds libkrunfw next to itself.
cp "$built" /out/lib/libkrun.so.1
patchelf --set-rpath '$ORIGIN' /out/lib/libkrun.so.1
strip --strip-unneeded /out/lib/libkrun.so.1

cp /tmp/libkrun/LICENSE /out/share/licenses/libkrun/
if [[ -f /tmp/libkrun/NOTICE ]]; then
  cp /tmp/libkrun/NOTICE /out/share/licenses/libkrun/
fi

# ---- launcher -----------------------------------------------------------------------------
cc -std=c11 -O2 -Wall -Wextra -Werror -D_GNU_SOURCE \
  -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now \
  -o /out/libexec/hive-vm /src/vm/hive-vm.c -ldl

# ---- checks -------------------------------------------------------------------------------
# Highest versioned glibc symbol a file asks for, e.g. GLIBC_2.28.
highest_glibc() {
  local file=$1
  local highest
  highest=$(objdump -T "$file" | grep -o 'GLIBC_[0-9.]*' | sed 's/^GLIBC_//' | sort -V -u | tail -n1 || true)
  [[ -n "$highest" ]] || fail "$file: no GLIBC versioned symbols found"
  if [[ "$(printf '%s\n%s\n' "$highest" "$min_glibc" | sort -V | tail -n1)" != "$min_glibc" ]]; then
    fail "$file: needs GLIBC $highest, newer than $min_glibc"
  fi
  echo "check: $file: highest GLIBC symbol is $highest (ok, <= $min_glibc)"
}

check_needed() {
  local file=$1
  local needed lib allowed found
  needed=$(readelf -d "$file" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')
  while read -r lib; do
    [[ -n "$lib" ]] || continue
    found=false
    for allowed in $allowed_needed; do
      if [[ "$lib" == "$allowed" ]]; then found=true; fi
    done
    if [[ "$found" != true ]]; then
      fail "$file: unexpected NEEDED library $lib"
    fi
    echo "check: $file: NEEDED $lib (ok)"
  done <<< "$needed"
}

check_libkrun() {
  local file=/out/lib/libkrun.so.1
  local runpath soname
  runpath=$(readelf -d "$file" | sed -n 's/.*(RUNPATH).*\[\(.*\)\]/\1/p')
  [[ "$runpath" == '$ORIGIN' ]] || fail "$file: RUNPATH is \"$runpath\", expected \$ORIGIN"
  echo "check: $file: RUNPATH is \$ORIGIN (ok)"
  soname=$(readelf -d "$file" | sed -n 's/.*(SONAME).*\[\(.*\)\]/\1/p')
  [[ "$soname" == "libkrun.so.1" ]] || fail "$file: SONAME is \"$soname\", expected libkrun.so.1"
  echo "check: $file: SONAME is libkrun.so.1 (ok)"
}

check_launcher() {
  local file=/out/libexec/hive-vm
  local type
  type=$(readelf -h "$file" | sed -n 's/^ *Type: *\([A-Za-z0-9_]*\).*/\1/p')
  [[ "$type" == "DYN" ]] || fail "$file: not position-independent (ELF type $type, expected DYN)"
  echo "check: $file: PIE (ELF type DYN) (ok)"
  readelf -l "$file" | grep -q 'GNU_RELRO' || fail "$file: no GNU_RELRO program header"
  echo "check: $file: GNU_RELRO program header present (ok)"
  if ! readelf -d "$file" | grep -Eq '\(FLAGS\).*BIND_NOW|\(FLAGS_1\).*NOW'; then
    fail "$file: not linked with BIND_NOW (full RELRO)"
  fi
  echo "check: $file: BIND_NOW (full RELRO) (ok)"
}

for file in /out/lib/libkrun.so.1 /out/libexec/hive-vm; do
  highest_glibc "$file"
  check_needed "$file"
done
check_libkrun
check_launcher

echo "native-in-container: done"
