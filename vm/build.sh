#!/usr/bin/env bash
# Build the libkrun launcher. Runs from any cwd; uses the sandbox image only when the host has
# no C compiler (the launcher needs no libkrun headers, so the compile is self-contained).
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
src="$repo_root/vm/hive-vm.c"
out="$repo_root/vm/hive-vm"
# Linux: the same hardening as distro packages (stack protector, _FORTIFY_SOURCE, PIE, full
# RELRO). macOS: none of those ELF linker flags exist; instead the launcher is ad-hoc signed with
# the two entitlements HVF and loading our own libkrun need (vm/hive-vm.entitlements).
if [ "$(uname -s)" = Darwin ]; then
  flags=(-std=gnu11 -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror -D_GNU_SOURCE
    -fstack-protector-strong -mmacosx-version-min=14.0)
else
  flags=(-std=c11 -O2 -Wall -Wextra -Werror -D_GNU_SOURCE
    -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now)
fi

if command -v cc >/dev/null 2>&1; then
  cc "${flags[@]}" -o "$out" "$src"
  if [ "$(uname -s)" = Darwin ]; then
    codesign --force --sign - --entitlements "$repo_root/vm/hive-vm.entitlements" "$out"
  fi
elif command -v podman >/dev/null 2>&1; then
  podman run --rm --log-driver none --security-opt label=disable -v "$repo_root/vm:/src" -w /src \
    "${HIVE_IMAGE:-localhost/agent-hive-sandbox:latest}" cc "${flags[@]}" -o hive-vm hive-vm.c
else
  echo "hive-vm: no C compiler on PATH and podman is not installed; install cc or podman" >&2
  exit 1
fi

echo "$out"
