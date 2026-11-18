## Goal

Add a third sandbox backend to agent-hive, `libkrun`, for Linux: a small C launcher `vm/hive-vm` that boots each task in its own libkrun microVM directly (no podman at run time), on a read-only shared root filesystem exported once from the existing sandbox image, with a throwaway writable overlay inside the guest, inside a pasta network namespace that cannot reach the host. It becomes the preferred backend when available; the podman backends (krun, runsc, crun/runc) keep working unchanged. Also add two things carried over from pi-vm: a persistent npm cache shared into sandboxes, and per-task token/cost totals.

The repo is a Node 20+ TypeScript ESM server (Fastify). Read `src/sandbox.ts`, `src/tasks.ts`, `src/config.ts`, `image/Containerfile`, `image/hive-agent` before starting.

## Files to touch

New:
- `vm/hive-vm.c` — the launcher
- `vm/build.sh` — builds `vm/hive-vm`
- `vm/build-rootfs.sh` — exports the sandbox image to a rootfs directory
- `image/hive-vm-init` — runs first inside the guest
- `test/hive-vm.test.mjs` — launcher CLI tests
- `test/sandbox.test.mjs` — server-side command-building tests

Modified:
- `image/Containerfile`
- `src/config.ts`, `src/sandbox.ts`, `src/tasks.ts`
- `ui/src/main.ts`
- `package.json`, `install.sh`, `.gitignore`, `README.md`, `AGENTS.md`

## Steps

### 0. Setup
1. `npm ci` in the repo root.

### 1. Launcher `vm/hive-vm.c`

Single C file, C11, no libkrun header. It loads libkrun at run time with `dlopen()` and `dlsym()`, so it builds with any C compiler and `--dry-run` works without libkrun installed. Library path: env `HIVE_LIBKRUN`, default `libkrun.so.1`. Declare these function pointer types locally, exactly:

```c
int32_t krun_set_log_level(uint32_t level);
int32_t krun_create_ctx(void);
int32_t krun_free_ctx(uint32_t ctx_id);
int32_t krun_set_vm_config(uint32_t ctx_id, uint8_t num_vcpus, uint32_t ram_mib);
int32_t krun_add_virtiofs3(uint32_t ctx_id, const char *c_tag, const char *c_path, uint64_t shm_size, bool read_only);
int32_t krun_set_workdir(uint32_t ctx_id, const char *workdir_path);
int32_t krun_set_exec(uint32_t ctx_id, const char *exec_path, const char *const argv[], const char *const envp[]);
int32_t krun_set_rlimits(uint32_t ctx_id, const char *const rlimits[]);
int32_t krun_set_port_map(uint32_t ctx_id, const char *const port_map[]);
int32_t krun_start_enter(uint32_t ctx_id);
```

CLI:

```
hive-vm --check
hive-vm [--dry-run] --rootfs DIR [--cpus N] [--memory MIB] [--share HOST:GUEST[:ro]]...
        [--env NAME]... [--setenv NAME=VALUE]... [--workdir PATH] [--dns ADDR]
        [--log-level N] -- COMMAND [ARGS...]
```

Parsing and validation (any failure: message on stderr starting `hive-vm: `, exit code 2):
- `--rootfs`: required, absolute path, must be an existing directory; store its `realpath()`.
- `--cpus`: integer 1–16, default 1. `--memory`: integer MiB 128–65536, default 1024.
- `--share HOST:GUEST[:ro]`: up to 8. HOST must be an existing directory, stored as `realpath()`. GUEST must be absolute, must not contain `..` components, `:` or `,`. Optional suffix `:ro` marks it read-only. Shares get tags `hive0`, `hive1`, … in order.
- `--env NAME`: copy NAME's value from the launcher's own environment into the guest env; silently skipped if unset. NAME must match `[A-Za-z_][A-Za-z0-9_]*`.
- `--setenv NAME=VALUE`: set an explicit guest env var (same NAME rule).
- `--workdir`: absolute guest path, default `/`.
- `--dns`: IPv4 address string, optional.
- `--log-level`: 0–5, default 1.
- `--` then COMMAND (required) and its ARGS.

Guest environment (`envp`, NULL-terminated, only these entries): the `--env` and `--setenv` vars, plus
`HIVE_SHARES=<tag>:<guest>[:ro],...` (comma-separated, in order; omit the variable when there are no shares), `HIVE_WORKDIR=<workdir>`, and `HIVE_DNS=<addr>` when `--dns` was given.

`--dry-run`: print one line of JSON to stdout and exit 0, without loading libkrun:
```json
{"rootfs":"/abs","cpus":2,"memory":1024,"shares":[{"tag":"hive0","host":"/abs","guest":"/work","ro":false}],"env":["NAME", "..."],"workdir":"/work","dns":"169.254.1.53","exec":"/usr/local/bin/hive-vm-init","argv":["COMMAND","ARGS..."]}
```
`env` lists only variable NAMES that will be passed (from `--env` that were set, and `--setenv`), never values. `dns` is `null` when not given. JSON-escape all strings correctly (quotes, backslashes, control characters).

Normal run (not dry-run):
1. Check `/dev/kvm` is readable and writable; otherwise `hive-vm: /dev/kvm is not usable`, exit 1.
2. `dlopen(lib, RTLD_NOW)` and resolve every symbol above; on failure print the `dlerror()` text and exit 1.
3. `krun_set_log_level(level)`; `ctx = krun_create_ctx()`; `krun_set_vm_config(ctx, cpus, memory)`.
4. Root: `krun_add_virtiofs3(ctx, "/dev/root", rootfs, 0, true)` (read-only).
5. Each share: `krun_add_virtiofs3(ctx, tag, host, 0, ro)`.
6. `krun_set_rlimits(ctx, (const char*[]){"7=65536:65536", NULL})` (RLIMIT_NOFILE).
7. `krun_set_port_map(ctx, (const char*[]){NULL})` — an EMPTY array, so no guest port is exposed to the host. Never pass NULL here (NULL exposes every listening guest port).
8. `krun_set_workdir(ctx, "/")`.
9. `krun_set_exec(ctx, "/usr/local/bin/hive-vm-init", argv, envp)` where `argv` is COMMAND followed by ARGS (NOT including the exec path), NULL-terminated.
10. `krun_start_enter(ctx)`. It only returns on error: print `hive-vm: krun_start_enter failed: <n>` and exit 1. Any other krun_* call returning < 0: print the function name and the value, exit 1.

`--check`: dlopen + resolve all symbols, `krun_create_ctx()` then `krun_free_ctx()`, and the `/dev/kvm` check. Print `ok` and exit 0, or the reason and exit 1.

Must compile cleanly with `cc -std=c11 -O2 -Wall -Wextra -Werror -D_GNU_SOURCE` (add `-ldl` only if the linker needs it; glibc ≥ 2.34 does not).

### 2. `vm/build.sh`

`#!/usr/bin/env bash`, `set -euo pipefail`, runs from any cwd (resolve the repo root from the script's own path). Compile `vm/hive-vm.c` to `vm/hive-vm` with the flags above. If `cc` is on PATH use it; otherwise run the compile inside the sandbox image: `podman run --rm --log-driver none -v "<repo>/vm:/src:Z" -w /src "${HIVE_IMAGE:-localhost/agent-hive-sandbox:latest}" cc <flags> -o hive-vm hive-vm.c`. If neither `cc` nor podman exists, print an error and exit 1. Print the output path at the end.

### 3. Guest init `image/hive-vm-init`

Bash, `set -euo pipefail`, executable. Runs as root as the first workload process in the guest (libkrun's own init has already mounted /proc, /sys, /dev). Steps, in order:
1. `R=/run/hive/root`. `mount -t tmpfs -o mode=0755,size="${HIVE_TMPFS_SIZE:-50%}" hive-tmp /run/hive`, then `mkdir -p /run/hive/upper /run/hive/work "$R"`.
2. `mount -t overlay overlay -o lowerdir=/,upperdir=/run/hive/upper,workdir=/run/hive/work "$R"` — the guest's writable root; all writes outside shares live in RAM and vanish with the VM.
3. `for d in proc sys dev; do mount --rbind "/$d" "$R/$d"; done`
4. For each comma-separated entry `tag:guest[:ro]` in `HIVE_SHARES` (may be unset/empty): `mkdir -p "$R$guest"`; `mount -t virtiofs [-o ro] "$tag" "$R$guest"`.
5. If `HIVE_DNS` is set: `rm -f "$R/etc/resolv.conf"` and write `nameserver $HIVE_DNS` into it.
6. Export `HOME=/root`, `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` (image `ENV` lines do not apply in this backend).
7. `exec chroot "$R" /usr/bin/env --chdir="${HIVE_WORKDIR:-/}" "$@"`.

### 4. `image/Containerfile`

Change the `COPY hive-agent hive-export /usr/local/bin/` line to also copy `hive-vm-init`. No other changes.

### 5. `vm/build-rootfs.sh`

Bash, `set -euo pipefail`. Exports the sandbox image to a plain directory the launcher uses as root.
- `IMAGE=${HIVE_IMAGE:-localhost/agent-hive-sandbox:latest}`; `BASE=${HIVE_ROOTFS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive/rootfs}`; `mkdir -p "$BASE"`.
- `id=$(podman image inspect --format '{{.Id}}' "$IMAGE" | cut -c1-12)`; `dest="$BASE/$id"`.
- If `$dest/.complete` exists: point `$BASE/current` at it (`ln -sfn "$id" "$BASE/current"`), print `$dest`, exit 0.
- Otherwise: `tmp=$(mktemp -d "$BASE/.tmp-XXXXXX")`; `cid=$(podman create "$IMAGE" true)`; a trap removes the container and `$tmp` on failure; `podman export "$cid" | tar -x -C "$tmp" --exclude='dev/*'`; `podman rm "$cid"`; `mv "$tmp" "$dest"`; `touch "$dest/.complete"`; remember the old `current` target, then `ln -sfn "$id" "$BASE/current"`.
- Delete every other directory in `$BASE` except `$id`, the previous `current` target, and names starting with `.` — so a task still running on the previous root keeps it.
- Fail with a clear message if `$dest/usr/local/bin/hive-vm-init` is missing (image built before step 4).
- Print `$dest`.

### 6. `src/config.ts`

Add to `config.sandbox`:
- `vmBin`: `process.env.HIVE_VM_BIN` or `<repo root>/vm/hive-vm`, where repo root is `resolve(dirname(fileURLToPath(import.meta.url)), "..")`.
- `rootfs`: `process.env.HIVE_ROOTFS` or `${XDG_DATA_HOME || ~/.local/share}/agent-hive/rootfs/current`.
- `libkrun`: `process.env.HIVE_LIBKRUN` or `"libkrun.so.1"`.
- `npmCache`: `process.env.HIVE_NPM_CACHE` if defined (empty string disables), else `${XDG_CACHE_HOME || ~/.cache}/agent-hive/npm`.

Update the `runtime` comment to list `auto | libkrun | krun | runsc | crun | runc`.

### 7. `src/sandbox.ts`

- `RuntimeInfo.runtime` may now be `"libkrun"` (isolation `"microvm"`).
- Export `parseMemoryMiB(s: string): number`: `"512m"`→512, `"1g"`→1024, `"2G"`→2048, bare `"768"`→768 (MiB). Throws on anything else.
- Export `hostNameserver(resolvConf: string): string`: the first `nameserver` line whose address is IPv4; `"1.1.1.1"` if none. Use the contents of `/etc/resolv.conf` at call time (empty string if unreadable).
- Export `libkrunAvailable(): boolean`: `/dev/kvm` usable, `config.sandbox.vmBin` exists, `<realpath of rootfs>/usr/local/bin/hive-vm-init` exists, `pasta` on PATH, and `execFileSync(vmBin, ["--check"], { env: {...process.env, HIVE_LIBKRUN: config.sandbox.libkrun} })` exits 0. Any exception → false.
- `detectRuntime()`: `HIVE_RUNTIME=libkrun` → `{ runtime: "libkrun", isolation: "microvm" }`. `auto` order: libkrun if `libkrunAvailable()`, then podman krun (existing check), then the existing container fallback. Update the error message listing valid values.
- Export `buildLibkrunCommand(opts: SandboxOptions, p: { vmBin: string; rootfs: string; cpus: number; memoryMiB: number; hostDns: string }): { file: string; args: string[] }` returning exactly:
  - `file`: `"pasta"`
  - `args`: `["--config-net", "-q", "-T", "none", "-U", "none", "--no-map-gw", "--dns-forward", "169.254.1.53", "--dns-host", p.hostDns, "--", p.vmBin, "--rootfs", p.rootfs, "--cpus", String(p.cpus), "--memory", String(p.memoryMiB), ...for each mount: "--share", `${host}:${container}` + (ro ? ":ro" : ""), ...for each env NAME (Object.keys(opts.env)): "--env", NAME, "--dns", "169.254.1.53", "--workdir", "/work", "--", ...opts.command]`
  - It never puts env VALUES in `args`.
- `runSandbox()`: when `runtimeInfo.runtime === "libkrun"`, spawn `buildLibkrunCommand(...)` (rootfs = `realpathSync(config.sandbox.rootfs)` resolved at spawn; cpus = `parseInt(config.sandbox.cpus)`; memoryMiB = `parseMemoryMiB(config.sandbox.memory)`; hostDns from `/etc/resolv.conf`) with `env: {...process.env, ...opts.env, HIVE_LIBKRUN: config.sandbox.libkrun}`, `stdio: ["ignore", "pipe", "pipe"]`, `detached: true`. Keep the same stdout JSONL parsing, stderr tail and `done` result shape. Timeout: a timer of `timeoutMin` minutes that sets `timedOut = true` and sends SIGKILL to the process group (`process.kill(-child.pid, "SIGKILL")`); clear it on close. `stop()`: SIGTERM to the process group, then SIGKILL to the group after 3 s if still running. Wrap group kills in try/catch (ESRCH). The podman path stays as it is.
- `checkSandbox()`: in libkrun mode, report missing `vmBin` (`build it with: npm run build:vm`) or missing rootfs (`create it with: npm run build:rootfs`) instead of the podman checks; podman mode unchanged.

### 8. `src/tasks.ts`

- npm cache (from pi-vm): in `runAgent` only (not export), when `config.sandbox.npmCache` is non-empty, `mkdirSync(..., { recursive: true })` it and add the mount `{ host: config.sandbox.npmCache, container: "/root/.npm" }`.
- Usage totals (from pi-vm's summary): add `usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }` to `Task`. On every `message_end` whose `message.role === "assistant"`, add `message.usage.input`, `.output`, `.cacheRead`, `.cacheWrite` and `message.usage.cost.total` (treat missing as 0). Include `usage` in `toJSON()` and in both `hive_done` events.

### 9. `ui/src/main.ts`

In the `hive_done` handler for status `idle`, append ` · $<cost>` to the done line when `e.usage?.cost > 0`, formatted with 4 decimals; escape like the rest.

### 10. `package.json`, `install.sh`, `.gitignore`

- Scripts: add `"build:vm": "bash vm/build.sh"`, `"build:rootfs": "bash vm/build-rootfs.sh"`, `"test": "npm run build && node --test 'test/*.test.mjs'"` (a bare `test/` directory argument does not work on Node 24).
- `install.sh`: after `npm run build:image`, if `uname` is Linux, `/dev/kvm` is readable and writable, `pasta` is on PATH and `ldconfig -p` lists `libkrun.so.1`: run `npm run build:vm` and `npm run build:rootfs` and echo `Isolation: libkrun microVMs (no podman at run time) ✓`. Otherwise keep the existing isolation messages.
- `.gitignore`: add `vm/hive-vm`.

### 11. Tests

`test/hive-vm.test.mjs` (node:test, spawnSync `vm/hive-vm`; fail, don't skip, if the binary is missing). Create temp dirs with `mkdtempSync`. Cases:
1. Dry run with `--rootfs <tmpA> --cpus 2 --memory 2048 --share <tmpB>:/work --share <tmpC>:/session:ro --env SECRET_KEY --setenv FOO=bar --dns 169.254.1.53 --workdir /work -- hive-agent --model x`, with `SECRET_KEY=sk-test-123` in the env: exit 0; parsed JSON has `cpus` 2, `memory` 2048, `shares[0]` = `{tag:"hive0", host: realpath(tmpB), guest:"/work", ro:false}`, `shares[1].ro === true`, `env` deep-equals `["SECRET_KEY","FOO"]`, `exec === "/usr/local/bin/hive-vm-init"`, `argv` deep-equals `["hive-agent","--model","x"]`; stdout does not contain `sk-test-123`.
2. `--env UNSET_VAR_XYZ` (unset) is omitted from `env`.
3. Exit 2 for each: relative `--rootfs`; missing `--rootfs`; nonexistent share host dir; guest path `/a/../b`; guest path `relative`; `--memory 64`; `--cpus 0`; no command after `--`; `--setenv 1BAD=x`.
4. `dns` is `null` when `--dns` is absent.

`test/sandbox.test.mjs` imports `../dist/sandbox.js`:
1. `parseMemoryMiB`: `"512m"`→512, `"1g"`→1024, `"2G"`→2048, `"768"`→768; throws on `"lots"`.
2. `hostNameserver`: `"nameserver 127.0.0.53\n"`→`"127.0.0.53"`; `"nameserver fe80::1\nnameserver 10.0.0.1\n"`→`"10.0.0.1"`; `""`→`"1.1.1.1"`.
3. `buildLibkrunCommand` with mounts `[{host:"/h/work",container:"/work"},{host:"/h/s",container:"/session",ro:true}]`, env `{OPENROUTER_API_KEY:"sk-or-secret"}`, command `["hive-agent","--model","m"]`, params `{vmBin:"/opt/hive-vm", rootfs:"/r", cpus:1, memoryMiB:1024, hostDns:"127.0.0.53"}`: `file === "pasta"`; `args` deep-equals the exact array specified in step 7; `args.join(" ")` does not contain `sk-or-secret`.

### 12. Docs

- `README.md`: in "Isolation levels", add a first row for `libkrun` (auto when `/dev/kvm`, libkrun, pasta, `vm/hive-vm` and the rootfs are present): own guest kernel, no podman at run time, read-only shared root with an in-RAM writable layer, network namespace that blocks the host's loopback, gateway and own addresses. Add `npm run build:vm` / `npm run build:rootfs` to the setup notes, and `HIVE_VM_BIN`, `HIVE_ROOTFS`, `HIVE_LIBKRUN`, `HIVE_NPM_CACHE` to the configuration table. Note that after `npm run build:image` you must re-run `npm run build:rootfs`.
- `AGENTS.md`: add `vm/` to the layout table, mention the libkrun backend and the npm cache in the security invariants (the shared npm cache is the one thing shared between tasks), and the `npm test` command.

## Acceptance

Run in the executor VM (no /dev/kvm there; nothing here boots a VM):
1. `npm ci` exits 0.
2. `npm run build` exits 0.
3. `bash vm/build.sh` exits 0 and `test -x vm/hive-vm` succeeds.
4. `cc -std=c11 -O2 -Wall -Wextra -Werror -D_GNU_SOURCE -fsyntax-only vm/hive-vm.c` exits 0.
5. `bash -n image/hive-vm-init && bash -n vm/build.sh && bash -n vm/build-rootfs.sh && bash -n install.sh` exits 0.
6. `node --test "test/*.test.mjs"` exits 0 and its summary shows `ℹ fail 0`.
7. `npm test` exits 0.
8. `test -x image/hive-vm-init` succeeds.
9. `grep -c 'hive-vm-init' image/Containerfile` prints `1`.
10. `cd ui && npm ci && npm run build` exits 0.

Host-only checks (the planner runs these after the run; the executor skips them and says so in the report):
11. `npm run build:image && npm run build:vm && npm run build:rootfs` exit 0.
12. With `HIVE_RUNTIME=libkrun`, the server logs `sandbox isolation: microvm (--runtime libkrun)`, `/snippet` returns a result, and a repo task with `reviewCycles: 1` pushes a `hive/<id>` branch.
13. From inside a libkrun guest, a server on the host's `127.0.0.1` is unreachable and `https://openrouter.ai` is reachable.
14. `/abort` during a run leaves no `hive-vm` or `pasta` process behind.

## Parallel work

Two workstreams; they share no files.

**Workstream A — launcher and guest side.** Owns: `vm/hive-vm.c`, `vm/build.sh`, `vm/build-rootfs.sh`, `image/hive-vm-init`, `image/Containerfile`, `test/hive-vm.test.mjs`. Steps 1–5 and test file 1 of step 11. Acceptance: `bash vm/build.sh && node --test test/hive-vm.test.mjs` exits 0, plus Acceptance items 4, 5 (first three scripts), 8, 9.

**Workstream B — server and UI.** Owns: `src/config.ts`, `src/sandbox.ts`, `src/tasks.ts`, `ui/src/main.ts`, `test/sandbox.test.mjs`. Steps 6–9 and test file 2 of step 11. It relies only on the hive-vm CLI contract written in step 1. Acceptance: `npm run build && node --test test/sandbox.test.mjs` exits 0, and `cd ui && npm run build` exits 0 (after `cd ui && npm ci`).

**Lead, after both finish:** steps 10 and 12 (`package.json`, `install.sh`, `.gitignore`, `README.md`, `AGENTS.md`), then run the full Acceptance list 1–10.

## Constraints

- Do not commit, push, or switch branches. Do not touch files outside **Files to touch** except `.handoff/report.md`. Installing system packages and temporary files outside the repo are fine.
- Do not change `image/hive-agent` or `image/hive-export`, the podman code path in `runSandbox`, or the task pipeline beyond step 8.
- No new npm dependencies. No libkrun header in the build; `vm/hive-vm.c` must not `#include <libkrun.h>`.
- Never place API key values on any command line, in dry-run output, or in logs.
- podman and /dev/kvm are not available in the executor VM: do not try to run `vm/build-rootfs.sh`, `hive-vm` without `--dry-run`, or `--check` expecting success.
- Keep the existing code style: ES modules, 2-space indent, comments only where they explain why.

## Out of scope

- macOS support, Windows, packaging/installers, a desktop shell.
- Local-folder repos, keychain storage, localhost Host/Origin hardening.
- OpenRouter provider routing and generated `models.json` from pi-vm.
- Blocking private LAN ranges other than the host's own addresses.
- Changing default memory/CPU values.

## If blocked

- If `cc` in the executor VM lacks something the launcher needs, `dnf -y install` it; if the code cannot meet `-Werror` because of a libc warning you cannot fix, stop and report the exact warning.
- If any step's instruction contradicts the existing code (a function or field it names does not exist), stop and report which one instead of guessing.
- If a workstream fails its own acceptance, do not paper over it in the other workstream; report it.
