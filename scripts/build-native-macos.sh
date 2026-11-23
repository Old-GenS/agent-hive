#!/usr/bin/env bash
# Build the release-grade macOS arm64 native pieces: libkrun (from source), libkrunfw (upstream's
# prebuilt guest kernel, compiled into the one dylib) and the hardened hive-vm launcher, signed
# ad-hoc with the two entitlements HVF and loading our own libraries need.
#
# The output matches the layout the release bundle and src/libkrun.ts expect:
#
#   build/native-macos/lib/libkrun.1.dylib
#   build/native-macos/lib/libkrunfw.5.dylib
#   build/native-macos/libexec/hive-vm
#
# The launcher preloads libkrunfw from libkrun's own directory, so the two dylibs must stay
# together. Output is reused while versions.json and the launcher sources are unchanged; pass
# --force to rebuild anyway. Runs from any cwd. Needs an Apple silicon Mac, Xcode command line
# tools, Rust (with the aarch64-apple-darwin std), make, git and network.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root=$(pwd)
out="${HIVE_NATIVE_MACOS_OUT:-$root/build/native-macos}"
work="${HIVE_NATIVE_MACOS_WORK:-$root/build/native-macos-work}"
force=false
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    -*)
      echo "build-native-macos: unknown option \"$arg\"" >&2
      exit 2
      ;;
    *)
      echo "build-native-macos: unexpected argument \"$arg\"" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "build-native-macos: $*" >&2
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || die "this build is macOS-only"
[[ "$(uname -m)" == arm64 ]] || die "libkrun's macOS backend is arm64-only"

for tool in git curl tar make cc clang rustc cargo node shasum find codesign install_name_tool otool; do
  command -v "$tool" >/dev/null 2>&1 || die "missing $tool"
done

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
libkrun_version=$(read_pin libkrun version)
libkrun_tag=$(read_pin libkrun tag)
libkrun_commit=$(read_pin libkrun commit)
libkrunfw_version=$(read_pin libkrunfw version)
libkrunfw_url=$(read_pin libkrunfw macos aarch64 url)
libkrunfw_sha256=$(read_pin libkrunfw macos aarch64 sha256)

# The pinned Rust toolchain is a Linux-container pin; on a Mac the installed stable toolchain is
# used. libkrun's makefile needs rust-lld and a libclang for bindgen, both of which ship with a
# normal Xcode/Rust install. Override the paths when they live somewhere else.
libclang_path="${LIBCLANG_PATH:-}"
if [[ -z "$libclang_path" ]]; then
  developer_dir=$(xcode-select -p 2>/dev/null || true)
  for candidate in \
    /Library/Developer/CommandLineTools/usr/lib \
    "$developer_dir/usr/lib" \
    "$developer_dir/Toolchains/XcodeDefault.xctoolchain/usr/lib"; do
    if [[ -f "$candidate/libclang.dylib" ]]; then libclang_path=$candidate; break; fi
  done
fi
[[ -n "$libclang_path" && -f "$libclang_path/libclang.dylib" ]] \
  || die "libclang not found (set LIBCLANG_PATH; Xcode command line tools provide it)"
rust_sysroot=$(rustc --print sysroot)
rust_lld="$rust_sysroot/lib/rustlib/aarch64-apple-darwin/bin/rust-lld"
[[ -x "$rust_lld" ]] || die "rust-lld not found at $rust_lld (install the aarch64-apple-darwin target)"

stamp=$(cd "$root" && shasum -a 256 versions.json vm/hive-vm.c vm/hive-vm.entitlements vm/build.sh scripts/build-native-macos.sh | shasum -a 256 | cut -d' ' -f1)
if [[ "$force" == false && -f "$out/STAMP" && "$(cat "$out/STAMP")" == "$stamp" &&
  -f "$out/lib/libkrun.1.dylib" && -f "$out/lib/libkrunfw.5.dylib" && -f "$out/libexec/hive-vm" ]]; then
  echo "build-native-macos: $out is up to date"
  echo "$out"
  exit 0
fi

mkdir -p "$work/logs" "$work/toolchain" "$work/cargo"

# lld is a multiplexer: it must be invoked as ld.lld, and --ld-path must point at that name.
ln -sfn "$rust_lld" "$work/toolchain/ld.lld"

# Keep Cargo's home inside the build tree; a sandboxed or read-only ~/.cargo must not matter.
if [[ ! -d "$work/cargo/registry" && -d "${HOME:-}/.cargo/registry" ]]; then
  echo "build-native-macos: seeding the cargo registry from $HOME/.cargo/registry" >&2
  cp -R "$HOME/.cargo/registry" "$work/cargo/registry"
fi

libkrun_dir="$work/libkrun"
if [[ ! -d "$libkrun_dir/.git" ]]; then
  git clone --depth 1 --branch "$libkrun_tag" "$libkrun_repo" "$libkrun_dir"
fi
git -C "$libkrun_dir" fetch --depth 1 origin tag "$libkrun_tag" 2>/dev/null || true
git -C "$libkrun_dir" checkout --detach "$libkrun_commit"
[[ "$(git -C "$libkrun_dir" rev-parse HEAD)" == "$libkrun_commit" ]] || die "libkrun is not at $libkrun_commit"

# bindgen's build scripts link @rpath/libclang.dylib without an rpath; dyld looks in the
# executable's directory first, so a symlink there is enough.
mkdir -p "$libkrun_dir/target/release"
ln -sf "$libclang_path/libclang.dylib" "$libkrun_dir/target/release/libclang.dylib"

sysroot="$libkrun_dir/linux-sysroot"
gcc_dir="$sysroot/usr/lib/gcc/aarch64-linux-gnu/12"
cc_linux="/usr/bin/clang -target aarch64-linux-gnu --ld-path=$work/toolchain/ld.lld -Wl,-strip-debug --sysroot=$sysroot -B$gcc_dir -L$gcc_dir -Wno-c23-extensions"

jobs=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
export CARGO_HOME="$work/cargo"
export LIBCLANG_PATH="$libclang_path"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
export CARGO_BUILD_JOBS="$jobs"

echo "build-native-macos: building libkrun $libkrun_tag" >&2
(
  cd "$libkrun_dir"
  make BLK=1 NET=1 CC_LINUX="$cc_linux" 2>&1 | tee "$work/logs/libkrun-build.log" >&2
  make BLK=1 NET=1 PREFIX="$work/prefix" install
)

libkrun_dylib="$work/prefix/lib/libkrun.$libkrun_version.dylib"
[[ -f "$libkrun_dylib" ]] || libkrun_dylib=$(ls "$work/prefix/lib"/libkrun.*.dylib 2>/dev/null | head -n1 || true)
[[ -f "$libkrun_dylib" ]] || die "libkrun's make install produced no dylib under $work/prefix/lib"

echo "build-native-macos: downloading libkrunfw $libkrunfw_version" >&2
mkdir -p "$work/libkrunfw"
libkrunfw_tgz="$work/libkrunfw/libkrunfw-prebuilt-aarch64.tgz"
curl -fsSL --retry 3 -o "$libkrunfw_tgz" "$libkrunfw_url"
printf '%s  %s\n' "$libkrunfw_sha256" "$libkrunfw_tgz" | shasum -a 256 -c - >/dev/null
rm -rf "$work/libkrunfw/src"
mkdir -p "$work/libkrunfw/src"
tar -xzf "$libkrunfw_tgz" -C "$work/libkrunfw/src"
libkrunfw_makefile=$(find "$work/libkrunfw/src" -maxdepth 2 -name Makefile -type f | head -n1)
[[ -n "$libkrunfw_makefile" ]] || die "$libkrunfw_url has no Makefile"
libkrunfw_dir=$(dirname "$libkrunfw_makefile")
(
  cd "$libkrunfw_dir"
  make CC=clang
)
# The Makefile names the dylib by ABI version (libkrunfw.5.dylib), not by release version.
libkrunfw_dylib="$libkrunfw_dir/libkrunfw.5.dylib"
[[ -f "$libkrunfw_dylib" ]] || die "libkrunfw's make produced no dylib"

staging=$(mktemp -d "$work/stage.XXXXXX")
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/lib" "$staging/libexec" "$staging/share/licenses/libkrun" "$staging/share/licenses/libkrunfw"

install -m 755 "$libkrun_dylib" "$staging/lib/libkrun.1.dylib"
install -m 755 "$libkrunfw_dylib" "$staging/lib/libkrunfw.5.dylib"
install_name_tool -id libkrun.1.dylib "$staging/lib/libkrun.1.dylib"
install_name_tool -id libkrunfw.5.dylib "$staging/lib/libkrunfw.5.dylib"

cc -std=gnu11 -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror -D_GNU_SOURCE \
  -fstack-protector-strong -mmacosx-version-min=14.0 \
  -o "$staging/libexec/hive-vm" "$root/vm/hive-vm.c"
codesign --force --sign - "$staging/lib/libkrun.1.dylib" "$staging/lib/libkrunfw.5.dylib"
codesign --force --sign - --entitlements "$root/vm/hive-vm.entitlements" "$staging/libexec/hive-vm"

install -m 644 "$libkrun_dir/LICENSE" "$staging/share/licenses/libkrun/LICENSE"
for file in "$libkrunfw_dir"/LICENSE*; do
  if [[ -f "$file" ]]; then install -m 644 "$file" "$staging/share/licenses/libkrunfw/"; fi
done
[[ -n "$(ls -A "$staging/share/licenses/libkrunfw")" ]] || die "libkrunfw has no LICENSE file"

otool -D "$staging/lib/libkrun.1.dylib" | tail -n1 | grep -qx "libkrun.1.dylib" || die "libkrun install name is not libkrun.1.dylib"
otool -D "$staging/lib/libkrunfw.5.dylib" | tail -n1 | grep -qx "libkrunfw.5.dylib" || die "libkrunfw install name is not libkrunfw.5.dylib"
codesign --verify --strict "$staging/libexec/hive-vm" || die "the launcher's signature does not verify"

if [[ "$(sysctl -n kern.hv_support 2>/dev/null || echo 0)" == 1 ]]; then
  HIVE_LIBKRUN="$staging/lib/libkrun.1.dylib" "$staging/libexec/hive-vm" --check \
    || die "the launcher cannot load the bundled libkrun"
else
  echo "build-native-macos: kern.hv_support is not 1 here; skipping the launcher's --check" >&2
fi

rm -rf "$out"
mv "$staging" "$out"
printf '%s\n' "$stamp" > "$out/STAMP"

echo "build-native-macos: built $out" >&2
echo "$out"
