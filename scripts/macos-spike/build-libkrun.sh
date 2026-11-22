#!/usr/bin/env bash
# Build the pinned libkrun (1.19.8) and the libkrunfw 5.6.2 dylib on a Mac.
#
# This is the Phase 0 build recipe from docs/MACOS.md, made reproducible inside
# the workspace. It never writes to ~/.cargo, never needs Homebrew's lld, and
# keeps every artifact under $SCRATCH (default: <repo>/.scratch).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRATCH=${SCRATCH:-$ROOT/.scratch}
PREFIX=${PREFIX:-$SCRATCH/prefix}
LIBKRUN_DIR=${LIBKRUN_DIR:-$SCRATCH/libkrun}
CARGO_HOME=${CARGO_HOME:-$SCRATCH/cargo}
LIBCLANG_PATH=${LIBCLANG_PATH:-/Library/Developer/CommandLineTools/usr/lib}
JOBS=${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}
MACOSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-14.0}

LIBKRUN_TAG=v1.19.8
LIBKRUN_COMMIT=c4d283c233bc0ae1993c289ec2a1b4da2242f1f8
LIBKRUNFW_VERSION=5.6.2
LIBKRUNFW_URL=https://github.com/containers/libkrunfw/releases/download/v${LIBKRUNFW_VERSION}/libkrunfw-prebuilt-aarch64.tgz
LIBKRUNFW_SHA256=adef6739cc3bda2a1b57f04c08ccbfdf206a6c831d76b32de1beddc0e7984e86

die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this recipe is macOS-only"
[ "$(uname -m)" = arm64 ] || die "libkrun's macOS backend is arm64-only"
[ "$(sysctl -n kern.hv_support 2>/dev/null || echo 0)" = 1 ] || die "Hypervisor.framework is not available"

for tool in clang make git curl tar xz xzcat ar; do
    command -v "$tool" >/dev/null 2>&1 || die "missing $tool"
done
[ -f "$LIBCLANG_PATH/libclang.dylib" ] || die "libclang not found under $LIBCLANG_PATH (set LIBCLANG_PATH)"

RUST_SYSROOT=$(rustc --print sysroot)
RUST_LLD="$RUST_SYSROOT/lib/rustlib/aarch64-apple-darwin/bin/rust-lld"
[ -x "$RUST_LLD" ] || die "rust-lld not found at $RUST_LLD"

mkdir -p "$SCRATCH"/{logs,toolchain,cargo,libkrunfw} "$PREFIX"
# lld is a multiplexer: it must be invoked as ld.lld, and --ld-path must point
# at that name. rust-lld is the same linker and ships with every Rust toolchain.
ln -sfn "$RUST_LLD" "$SCRATCH/toolchain/ld.lld"
echo "ld.lld -> $RUST_LLD"

# Cargo cannot write ~/.cargo in the sandbox. Seed a workspace CARGO_HOME from
# the registry cache so the build does not need to download every crate again.
if [ ! -d "$CARGO_HOME/registry" ] && [ -d "$HOME/.cargo/registry" ]; then
    echo "copying ~/.cargo/registry to $CARGO_HOME (this takes a few seconds)"
    cp -R "$HOME/.cargo/registry" "$CARGO_HOME/registry"
fi

if [ ! -d "$LIBKRUN_DIR/.git" ]; then
    git clone --depth 1 --branch "$LIBKRUN_TAG" https://github.com/containers/libkrun "$LIBKRUN_DIR"
fi
git -C "$LIBKRUN_DIR" fetch --depth 1 origin tag "$LIBKRUN_TAG" 2>/dev/null || true
git -C "$LIBKRUN_DIR" checkout --detach "$LIBKRUN_COMMIT"
[ "$(git -C "$LIBKRUN_DIR" rev-parse HEAD)" = "$LIBKRUN_COMMIT" ] || die "libkrun is not at $LIBKRUN_COMMIT"

# krun-input/krun-display build scripts link @rpath/libclang.dylib without an
# rpath. dyld tries the executable's directory; a symlink there is enough.
mkdir -p "$LIBKRUN_DIR/target/release"
ln -sf "$LIBCLANG_PATH/libclang.dylib" "$LIBKRUN_DIR/target/release/libclang.dylib"

SYSROOT="$LIBKRUN_DIR/linux-sysroot"
GCC_DIR="$SYSROOT/usr/lib/gcc/aarch64-linux-gnu/12"
# The Makefile cross-compiles the guest init for aarch64 Linux and downloads its
# Debian sysroot. Apple clang does not search the GCC runtime directory, so pass
# it with -B/-L, and use rust-lld through its ld.lld name.
CC_LINUX="/usr/bin/clang -target aarch64-linux-gnu --ld-path=$SCRATCH/toolchain/ld.lld -Wl,-strip-debug --sysroot=$SYSROOT -B$GCC_DIR -L$GCC_DIR -Wno-c23-extensions"

export CARGO_HOME LIBCLANG_PATH MACOSX_DEPLOYMENT_TARGET CARGO_BUILD_JOBS="$JOBS"
echo "building libkrun $LIBKRUN_TAG (BLK=1 NET=1)"
cd "$LIBKRUN_DIR"
make BLK=1 NET=1 CC_LINUX="$CC_LINUX" 2>&1 | tee "$SCRATCH/logs/libkrun-build.log"
make BLK=1 NET=1 PREFIX="$PREFIX" install

# libkrunfw's "prebuilt" aarch64 tarball is the bundled kernel.c plus a Makefile;
# its Makefile compiles one dylib with the system C compiler.
mkdir -p "$SCRATCH/libkrunfw"
if [ ! -f "$SCRATCH/libkrunfw/libkrunfw-prebuilt-aarch64.tgz" ]; then
    echo "downloading libkrunfw $LIBKRUNFW_VERSION"
    curl -fL --retry 3 -o "$SCRATCH/libkrunfw/libkrunfw-prebuilt-aarch64.tgz" "$LIBKRUNFW_URL"
fi
echo "$LIBKRUNFW_SHA256  $SCRATCH/libkrunfw/libkrunfw-prebuilt-aarch64.tgz" | shasum -a 256 -c -
tar -xzf "$SCRATCH/libkrunfw/libkrunfw-prebuilt-aarch64.tgz" -C "$SCRATCH/libkrunfw"
(cd "$SCRATCH/libkrunfw/libkrunfw" && make CC=clang)
install -m 755 "$SCRATCH/libkrunfw/libkrunfw/libkrunfw.5.dylib" "$PREFIX/lib/libkrunfw.5.dylib"
ln -sfn libkrunfw.5.dylib "$PREFIX/lib/libkrunfw.dylib"

echo
echo "built:"
ls -lh "$PREFIX/lib/libkrun.1.19.8.dylib" "$PREFIX/lib/libkrunfw.5.dylib"
shasum -a 256 "$PREFIX/lib/libkrun.1.19.8.dylib" "$PREFIX/lib/libkrunfw.5.dylib"
