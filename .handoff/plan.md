## Goal

Close a VM-to-host escape. A run's `io/` folder is shared read-write with every VM step of the run
(the main step, review cycles, follow-ups), and `out/` with the export VM. Between steps the host
reads and writes files there **by name, following symlinks**, so an agent in one step can plant a
symlink that makes the host, before the next step:

- read any host file into `io/` (e.g. `io/system-base.md` → `../../../../.config/agent-hive/env`
  copies the keys file into the next step's system prompt);
- write agent-controlled text into any host file (e.g. `io/system.md` → `~/.bashrc`);
- read a host file as a "patch" (`out/0001-x.patch` → a symlink) during `git am`.

Fix it everywhere: host-only data never lives in `io/`; every host write into a VM-shared folder
creates a fresh file without following links; every host read from one goes through a single safe
reader (`O_NOFOLLOW`, regular files only, size cap); patches are copied into a host-only folder
before git sees them.

## Files to touch

- `src/vmfiles.ts` (new)
- `src/runs.ts`
- `src/sandbox.ts`
- `src/git.ts`
- `src/web-runs.ts`
- `src/follow.ts`
- `test/vmfiles.test.mjs` (new)
- `test/symlink-escape.test.mjs` (new)
- `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `src/vmfiles.ts` (new): the only way host code touches files in a VM-shared folder (`io/`,
   `io-export/`, `out/`, and the `hivectl`-style folders are excluded: the launcher handles those).
   - `export function readVmFile(path: string, max = 50 * 1024 * 1024): string` — `openSync(path,
     O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, `fstatSync` must be a regular file (`isFile()`), else
     throw `` `not a regular file: ${path}` ``; refuse files larger than `max`
     (`` `too large: ${path}` ``); read with the fd (never by path); close in `finally`.
     `O_NONBLOCK` keeps a FIFO from hanging the open (it then fails the regular-file check).
   - `export function readVmFileOrEmpty(path, max?)`: `""` when the file is missing (`ENOENT`);
     any other refusal still throws.
   - `export function writeVmFile(path: string, data: string | Buffer): void` — `rmSync(path,
     { force: true })` (removes a planted symlink or file, never follows it; if `path` is a
     directory, throw `` `not a file: ${path}` `` instead of deleting it), then `writeFileSync(path,
     data, { flag: "wx", mode: 0o644 })` (`O_CREAT | O_EXCL`: fails rather than follows if
     something reappeared).
   - `export function copyVmFileOut(src: string, dest: string, max?)`: `readVmFile(src)` and write
     to `dest` (a host-only path) with `flag: "wx"`.

3. `src/runs.ts`:
   - **Host-only base prompt:** `startRun` writes the run's system prompt to `<run>/system-base.md`
     (the run folder, which no VM mounts), not `io/system-base.md`. `agentStep` reads it from
     there with a normal `readFileSync` (it's host-only); when missing (older runs), use
     `config.systemPrompt`. **Never read `io/system-base.md`.**
   - `io/system.md` and `io/prompt.md` are written with `writeVmFile`.
   - The event-log slimming after a step: read `io/events.jsonl` with `readVmFileOrEmpty`, write the
     slimmed text to `io/events.jsonl` with `writeVmFile` (drop the `.tmp` + `renameSync` dance);
     on any refusal leave the log as it is (it's already inside `io/`).
   - `io/stderr.log` for the error message: `readVmFileOrEmpty` (capped, e.g. 1 MB, tail kept as
     today).
   - The per-step renames (`events.jsonl` → `events-<n>.jsonl`, `stderr.log` → `stderr-<n>.log`)
     may stay `renameSync` (renaming a symlink renames the link, it doesn't follow it).
   - `patchFiles(dir)`: keep only entries that `lstatSync` says are regular files.
   - `exportRun`: copy each patch with `copyVmFileOut` into a host-only temp folder (inside the
     export's `mkdtempSync` dir) and pass **those** paths to `git am`.
   - `reportMarkdown` and everything reading `meta.json` stay as they are (host-only file).
   - The OpenRouter `io/pi-agent` copy: keep `rmSync(…, { recursive: true, force: true })` (doesn't
     follow) and `cpSync`; add a comment that this is safe because no VM runs between the two.

4. `src/git.ts`, `applyAndPush`: before `git am`, copy every `out/*.patch` that `lstatSync` says is
   a regular file into a host-only temp folder with `copyVmFileOut`; check the count and total size
   on the copies (`MAX_PATCHES`, `MAX_PATCH_BYTES` as today); run `git am` on the copies; remove
   the temp folder in `finally`. Non-regular entries are ignored.

5. `src/sandbox.ts`: `resetIoDir` keeps its unlink + `wx` creation; replace `readTail`'s open with
   the same checks as `readVmFile` (regular file only, `O_NONBLOCK`) or call into `vmfiles.ts`.
   `src/follow.ts`: after its `O_NOFOLLOW` open, also require `fstatSync(fd).isFile()` (skip the
   poll otherwise) and open with `O_NONBLOCK`.

6. `src/web-runs.ts`: the finished-run replay reads `io/events-<n>.jsonl` and `io/events.jsonl`
   with `readVmFileOrEmpty` (skip a file it refuses).

7. Search the whole `src/` tree for any other `readFileSync`, `writeFileSync`, `appendFileSync`,
   `openSync`, `createReadStream`, `copyFileSync` or `statSync` on a path under a run's `io/`,
   `io-export/` or `out/` folder and move it to `vmfiles.ts` helpers (or `lstatSync`). List each
   place in the report.

8. Tests:
   - `test/vmfiles.test.mjs` (new): `readVmFile` on a regular file works; on a symlink to a real
     file throws (and doesn't return its content); on a FIFO (`mkfifo` via `child_process`, skip
     the case if `mkfifo` is missing) throws without hanging; over `max` throws;
     `readVmFileOrEmpty` on a missing file returns `""`. `writeVmFile` over a symlink pointing at a
     host file replaces the link with a regular file and leaves the target's content unchanged;
     onto a directory throws and leaves it.
   - `test/symlink-escape.test.mjs` (new; temp `HIVE_RUNS_DIR`, `HIVE_KEYS_FILE`,
     `HIVE_DOTENV_PATH` set before importing `../dist/`): build a fake finished run folder and a
     "secret" host file outside it. Plant, as a VM could:
     `io/system.md` → secret, `io/prompt.md` → secret, `io/system-base.md` → secret,
     `io/events.jsonl` → secret, `io/stderr.log` → secret, `out/0001-x.patch` → secret.
     Then call the host code paths without booting a VM (export the small internal pieces you
     need, e.g. a `prepareStepFiles(dir, meta, prompt)` that writes `system.md`/`prompt.md`, and a
     `slimStepLog(dir)`), plus `patchFiles` and `exportRun` on a run whose `out/` has one real
     patch and one symlinked one. Assert: the secret file's content is unchanged; no file under
     `io/` contains the secret text; `patchFiles` ignores the symlink; `exportRun` succeeds with
     the real patch only.

9. `AGENTS.md`, security rule 8: files the VM can write (`io/`, `io-export/`, `out/`) are read
   only through `src/vmfiles.ts` (`O_NOFOLLOW`, regular files only, size caps) and written only by
   deleting first and creating with `wx`; host-only data (the base system prompt, `meta.json`)
   lives in the run folder, never in `io/`; patches are copied out of `out/` before git reads them.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/vmfiles.test.mjs test/symlink-escape.test.mjs` exits 0 (after `npm run build`).
- `grep -n 'io", "system-base.md"\|io/system-base' src/*.ts` prints nothing.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never boot a hive VM, start `hive run`,
  start the server or call GitHub/OpenRouter. If something outside Acceptance fails, note it in the
  report and finish.
- No new dependencies. Don't change `vm/` or `image/`. Keep run behaviour the same apart from these
  file-handling changes.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- The shared VM cache (`HIVE_VM_CACHE`) cross-run trade-off, disk quotas.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
