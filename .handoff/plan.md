## Goal

1. **Fewer shared folders per VM.** libkrun runs out of interrupt slots (`IrqsExhausted`) when a VM
   has more than 5 `--share` folders, and the VM then never boots. An agent step uses 5 today
   (`/work`, `/session`, `/root/.npm`, `/root/.cache`, plus `/io` added by `runSandbox`). Bring it
   to 3: pi's session moves inside `/io` (`/io/session`), and the npm cache moves inside the shared
   `~/.cache` (`NPM_CONFIG_CACHE=/root/.cache/npm`). `runSandbox` refuses more than 5 shares with a
   clear error instead of a VM that silently fails.
2. **Launcher errors reach the run's error message.** When hive starts the launcher (through
   pasta, from Node), the launcher's stderr never reaches hive, so a failed boot shows as
   `agent exited 1:` with nothing after it. The launcher gets `--stderr-file <path>` and sends its
   own stderr (including libkrun's log lines) there; hive reads that file.

## Files to touch

- `vm/hive-vm.c`
- `src/sandbox.ts`
- `src/runs.ts`
- `src/config.ts`
- `src/routes/system.ts`
- `test/hive-vm.test.mjs`
- `test/hive-vm-watchdog.test.mjs`
- `test/sandbox.test.mjs`
- `test/run-steps.test.mjs`
- `README.md`
- `.env.example`
- `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `bash vm/build.sh`.

2. `vm/hive-vm.c`: add an optional `--stderr-file <path>` (absolute path, else usage error starting
   `hive-vm: `). Include it in the `--dry-run` JSON as `"stderr_file"` (`null` when not given). As
   soon as arguments are parsed (before loading libkrun and before `fork()`), open the path with
   `O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC`, mode `0600`, and `dup2` it onto fd 2
   (then close the original fd); failure to open → `fail_runtime` (which still goes to the
   original stderr). Update the usage text. Keep `-std=c11 -O2 -Wall -Wextra -Werror` clean. No
   other behaviour change.

3. `src/sandbox.ts`:
   - `buildLibkrunCommand` gets a new `stderrFile: string` in its second parameter and passes
     `"--stderr-file", stderrFile` to `hive-vm` (before `--share`). `spawnLibkrun` sets it to
     `<ioDir>.launcher.log` (a sibling of the io folder, e.g. `<run>/io.launcher.log` and
     `<run>/io-export.launcher.log`; never inside the io folder, which the VM can write).
   - In `runSandbox`'s close handler, the returned `stderr` is: the tail of the launcher log, then
     the tail of `<ioDir>/stderr.log`, then whatever arrived on the pipe (each part only when
     non-empty, joined with `\n`, the whole kept to `MAX_KEPT_OUTPUT` from the end).
   - `export const MAX_SHARES = 5`. `runSandbox` throws
     `` `too many shared folders for one VM: ${n} (libkrun supports ${MAX_SHARES})` `` when
     `opts.mounts.length + 1` (the `/io` share) is more than `MAX_SHARES`, before anything starts.
   - Update the existing `buildLibkrunCommand` test in `test/sandbox.test.mjs` for the new argument.

4. `src/config.ts`: remove `sandbox.npmCache` (`HIVE_NPM_CACHE`). `src/routes/system.ts`: replace
   `npmCache: Boolean(config.sandbox.npmCache)` with `vmCache: Boolean(config.sandbox.vmCache)`,
   **and** keep the old key too as `npmCache: Boolean(config.sandbox.vmCache)` (the UI reads
   `npmCache`).

5. `src/runs.ts`:
   - `export function stepMounts(dir: string): SandboxOptions["mounts"]` returns `/work` and, when
     `config.sandbox.vmCache` is non-empty, `{ host: config.sandbox.vmCache, container:
     "/root/.cache", shared: true }` (after `mkdirSync(vmCache, { recursive: true })`). Every agent
     step uses it; there is no `/session` and no `/root/.npm` mount any more.
   - The agent step's env adds `NPM_CONFIG_CACHE=/root/.cache/npm` when `vmCache` is set.
   - pi's session lives in `<run>/io/session` (`--session-dir /io/session`, plus `--continue` for
     follow-ups as today). `makeRunDir` creates `io/session` and no longer creates `session/`.
     Before each agent step, if `<run>/session` exists and `<run>/io/session` does not, move it
     there with `renameSync` (runs made before this change keep their session); if both exist,
     leave both and use `io/session`.
   - Update the run-folder layout comment at the top of the file.

6. Tests:
   - `test/hive-vm.test.mjs`: `--dry-run ... --stderr-file /tmp/x.log` shows
     `"stderr_file":"/tmp/x.log"`; without it `"stderr_file":null`; a relative path fails with a
     usage error starting `hive-vm: `.
   - `test/hive-vm-watchdog.test.mjs`: add a case with a second fake libkrun whose
     `krun_start_enter` returns `-22` immediately: run the launcher with `--stderr-file <tmp file>`;
     it exits non-zero within 10 s and the file contains `krun_start_enter failed`. Follow the
     file's existing compile/skip/cleanup pattern.
   - `test/sandbox.test.mjs`: `runSandbox` with 5 mounts (5 + `/io` = 6) throws the
     "too many shared folders" error and starts nothing (the throw happens before spawning).
   - `test/run-steps.test.mjs`: `stepMounts(dir)` returns at most 2 mounts, none at `/session` or
     `/root/.npm`, and `/root/.cache` only when `vmCache` is set (temp `HIVE_VM_CACHE` set before
     importing, like the other tests).

7. Docs: `README.md` and `.env.example` — drop `HIVE_NPM_CACHE`, say the npm cache now lives inside
   the shared VM cache (`HIVE_VM_CACHE`), update the run-folder layout (`io/session`), and add a
   note that a VM can have at most 5 shared folders (libkrun's interrupt limit). `AGENTS.md` — in
   the security section, note that the launcher log (`<io>.launcher.log`) sits outside the
   VM-writable io folder, and that a VM only ever shares its own run's `work/` and `io/` plus the
   VM cache, never the run folder itself (it holds `origin/`, which the host pushes from).

## Acceptance

- `bash vm/build.sh` exits 0.
- `npm run build` exits 0.
- `npm test` exits 0.
- `vm/hive-vm --dry-run --rootfs / --stderr-file /tmp/x.log -- true` prints JSON containing
  `"stderr_file":"/tmp/x.log"` (spacing as the launcher prints it).
- `grep -rn "npmCache\b" src | grep -v "routes/system.ts"` prints nothing.
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
  libkrun, start `hive run`, start the server or call GitHub/OpenRouter. If something outside
  Acceptance fails, note it in the report and finish.
- Don't change `image/` or `ui/`. Keep the stall watchdog, time note, slim logs, OpenRouter config
  in `/io/pi-agent`, follow-ups, reviews, new projects and the queue working as they are. No new
  dependencies.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Bind mounts inside the VM, changes to `hive-vm-init`, rebuilding the VM image.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
