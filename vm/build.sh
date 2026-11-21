#!/usr/bin/env bash
# Build the libkrun launcher. Runs from any cwd; uses the sandbox image only when the host has
# no C compiler (the launcher needs no libkrun headers, so the compile is self-contained).
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
src="$repo_root/vm/hive-vm.c"
out="$repo_root/vm/hive-vm"
# Same hardening as distro packages: stack protector, _FORTIFY_SOURCE, PIE and full RELRO.
flags=(-std=c11 -O2 -Wall -Wextra -Werror -D_GNU_SOURCE
  -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now)

if command -v cc >/dev/null 2>&1; then
  cc "${flags[@]}" -o "$out" "$src"
elif command -v podman >/dev/null 2>&1; then
  podman run --rm --log-driver none --security-opt label=disable -v "$repo_root/vm:/src" -w /src \
    "${HIVE_IMAGE:-localhost/agent-hive-sandbox:latest}" cc "${flags[@]}" -o hive-vm hive-vm.c
else
  echo "hive-vm: no C compiler on PATH and podman is not installed; install cc or podman" >&2
  exit 1
fi

echo "$out"
