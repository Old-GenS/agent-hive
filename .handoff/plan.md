## Goal

A VM must never outlive the process that started it, or its time limit, even if the CLI or server
crashes. Today the time limit lives only in the Node process; if that process is killed, its VMs
keep running. Teach the launcher `vm/hive-vm` two new options and pass them from Node:

- `--watch-pid <pid>`: stop the VM when that process no longer exists.
- `--timeout <seconds>`: stop the VM when that much time has passed.

## Files to touch

- `vm/hive-vm.c`
- `src/sandbox.ts`
- `test/hive-vm.test.mjs`
- `test/sandbox.test.mjs`
- `test/hive-vm-watchdog.test.mjs` (new)
- `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `bash vm/build.sh`.

2. `vm/hive-vm.c`:
   - Parse `--watch-pid <n>` (integer 1..4194304) and `--timeout <n>` (integer seconds 1..86400),
     both optional, with the existing `parse_uint`-style validation and error messages. Include them
     in the `--dry-run` JSON output as `"watch_pid"` and `"timeout"` (`null` when not given), next to
     the existing fields. Update the usage text.
   - In the parent branch after `fork()` (where it currently blocks in `waitpid(child, &status, 0)`),
     replace the blocking wait with a loop that runs every 500 ms:
     - `waitpid(child, &status, WNOHANG)`; if the child exited, keep the current exit handling.
     - If `--watch-pid` was given and `kill(watch_pid, 0) == -1 && errno == ESRCH`, or `getppid()`
       became 1 while the original parent was not 1, print
       `hive-vm: owner process <pid> is gone; stopping the VM` to stderr and stop the child.
     - If `--timeout` was given and the elapsed time (from `clock_gettime(CLOCK_MONOTONIC)` taken just
       before `fork()`) is at least the timeout, print `hive-vm: timed out after <n> s; stopping the VM`
       and stop the child.
     - "Stop the child": `kill(child, SIGTERM)`, wait up to 5 s (polling `waitpid` with `WNOHANG`
       every 100 ms), then `kill(child, SIGKILL)` and `waitpid` it. Then `remove_ctl(ctl)` and exit
       with code **124** for a timeout and **125** for a vanished owner.
     - Keep forwarding SIGTERM/SIGINT/SIGHUP to the child as today; use `nanosleep` and handle
       `EINTR` so a forwarded signal doesn't break the loop.
   - Keep `-std=c11 -O2 -Wall -Wextra -Werror` clean.

3. `src/sandbox.ts`:
   - `buildLibkrunCommand` adds `"--watch-pid", String(process.pid)` and
     `"--timeout", String(timeoutSec)` to the `hive-vm` arguments (before `--`), where `timeoutSec`
     comes from a new field in its second parameter, `timeoutSec: number`, set by `spawnLibkrun` to
     `config.sandbox.timeoutMin * 60`.
   - Keep the Node-side timer as a second line of defence. In `runSandbox`'s close handler, also
     treat exit code 124 as `timedOut: true`. Exit code 125 needs no special handling.
   - Update the existing `buildLibkrunCommand` test in `test/sandbox.test.mjs` for the new arguments
     and add assertions that they are present.

4. `test/hive-vm.test.mjs`: add `--dry-run` cases: `--watch-pid 1234 --timeout 60` appear in the JSON
   as numbers; `--watch-pid 0`, `--watch-pid abc` and `--timeout 0` fail with a usage error starting
   `hive-vm: `.

5. `test/hive-vm-watchdog.test.mjs` (new): skip the whole file (`test.skip` / `{ skip: "no C compiler" }`)
   when `cc` is not on PATH. Otherwise compile a **fake libkrun** in a temp dir: a C file defining every
   symbol `hive-vm` loads (`krun_set_log_level`, `krun_create_ctx` returning 1, `krun_free_ctx`,
   `krun_set_vm_config`, `krun_add_virtiofs3`, `krun_set_workdir`, `krun_set_exec`,
   `krun_set_rlimits`, `krun_set_port_map`, each returning 0, and `krun_start_enter` that sleeps
   for 60 s then returns 0), built with `cc -shared -fPIC -o libfakekrun.so fake.c`. Run the launcher
   with `HIVE_LIBKRUN=<that .so>` and the minimum valid arguments (a temp rootfs dir, `--` and a
   command), so the "VM" is the sleeping fake:
   - with `--timeout 1`: it exits with code 124 within 10 s and stderr contains `timed out after 1 s`;
   - with `--watch-pid <pid of a short-lived child process you start and then kill>`: after killing
     that process, the launcher exits with code 125 within 10 s and stderr contains
     `owner process`;
   - with neither, and the launcher sent SIGTERM after 1 s: it exits (the existing forwarding still
     works) within 10 s.
   Make sure no launcher or fake process is left running when the test ends (kill in `finally`).
   If `hive-vm` needs `/dev/kvm` before loading libkrun in this path, check how `--check` vs a normal
   run behaves and, if a normal run refuses without KVM, skip the file when `/dev/kvm` is missing
   too (say so in the report).

6. `AGENTS.md`: in the security section, add that the launcher stops the VM when its owner process
   is gone or the time limit passes (`--watch-pid`, `--timeout`), so a crashed CLI or server never
   leaves a VM running.

## Acceptance

- `bash vm/build.sh` exits 0.
- `npm test` exits 0 (the watchdog test runs, or is skipped only for a missing compiler or
  `/dev/kvm` as described in step 5).
- `vm/hive-vm --dry-run --rootfs / --watch-pid 1 --timeout 30 -- true` prints JSON containing
  `"watch_pid":1` and `"timeout":30` (adjust spacing to the launcher's actual JSON style; the
  values must be present as numbers).
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never boot a real VM with the real
  libkrun or start an agent. If something outside Acceptance fails, note it in the report and finish.
- Don't change the launcher's other behaviour (argument validation, shares, env, control directory,
  empty port map). No new dependencies.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- The stall watchdog and startup cleanup (stage 1 of `docs/CORE.md`), the CLI's and server's own
  timers beyond step 3.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
