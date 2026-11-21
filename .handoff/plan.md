## Goal

Close the two trade-offs left from the security review.

1. **Per-repo VM cache.** Today one `~/.cache` folder (`config.sandbox.vmCache`) is mounted
   read-write at `/root/.cache` in every agent VM of every run, so a run on repo A can plant a
   poisoned npm/pip/Playwright download that a later run on repo B executes. Give each repo its
   own cache bucket: runs of the same repo (and its follow-ups and review cycles) share one; runs of
   different repos never see each other's. Old buckets are pruned; the old flat cache is deleted.
2. **Disk limits.** A run's VM writes to host disk through `work/`, `io/` and its cache bucket with
   no limit. Add a disk watchdog that stops the agent step when the run (run folder + its cache
   bucket) grows past a size cap, or when the host's free space on that disk drops below a floor.
   Committed work is kept as with any other failure.

## Files to touch

- `src/config.ts`
- `src/vmcache.ts` (new)
- `src/diskwatch.ts` (new)
- `src/runs.ts`
- `test/vmcache.test.mjs` (new)
- `test/diskwatch.test.mjs` (new)
- `test/run-status.test.mjs`
- `docs/CONFIGURATION.md`
- `docs/HOW-IT-WORKS.md`
- `docs/ROADMAP.md`
- `AGENTS.md`
- `README.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `src/config.ts`:
   - Top level, next to `runRetentionDays`: `vmCacheDays: int("HIVE_VM_CACHE_DAYS", 30, 0)` with a
     doc comment: "Per-repo VM cache buckets not used for this many days are deleted; 0 keeps them."
   - In `sandbox`: `diskMaxGb: int("HIVE_RUN_DISK_MAX_GB", 20, 0)` ("Stop an agent step when the run
     folder plus its cache bucket uses more than this many GB; 0 turns it off.") and
     `minFreeGb: int("HIVE_MIN_FREE_DISK_GB", 2, 0)` ("Stop an agent step when less than this many
     GB are free on the disk holding the runs; 0 turns it off.").
   - Update the `vmCache` comment: the folder now holds one bucket per repo under `repos/`.
   - Check how `int(name, default, min)` is defined in this file and use it the same way.

3. `src/vmcache.ts` (new):
   - `export function cacheKey(meta: Pick<RunMeta, "source" | "repo" | "newRepo">): string`:
     builds an identity string, then returns the first 16 hex chars of its sha256.
     - `source === "new"`: `"new:" + meta.newRepo!.name.toLowerCase()`.
     - `source === "remote"`: normalise `meta.repo`: if it is a github.com repo in any form
       (`https://github.com/o/n(.git)`, `ssh://git@github.com/o/n(.git)`, `git@github.com:o/n(.git)`),
       use `"github:" + "o/n".toLowerCase()`; otherwise the URL lowercased with a trailing `/` and
       `.git` removed.
     - `source === "local"`: `"local:" + realpathSync(meta.repo)` (fall back to `meta.repo` when
       realpath throws).
   - `export function cacheBucket(meta): string | undefined`: `undefined` when
     `config.sandbox.vmCache` is empty; else `join(config.sandbox.vmCache, "repos", cacheKey(meta))`.
   - `export function useCacheBucket(meta): string | undefined`: like `cacheBucket`, but also
     `mkdirSync(bucket, { recursive: true })` and writes the host-only marker
     `join(vmCache, "repos", key + ".used")` (an empty file; `writeFileSync` then `utimesSync` to
     now). The marker sits next to the bucket, not inside it, so no VM can touch it.
   - `export function pruneVmCache(liveKeys: Set<string>, now = Date.now()): string[]`: no-op
     returning `[]` when `vmCache` is empty or missing.
     - Legacy cleanup: delete every entry directly under `vmCache` except `repos`
       (`rmSync(path, { recursive: true, force: true })`, which never follows symlinks). Use
       `lstatSync`/`readdirSync` with `withFileTypes`.
     - When `config.vmCacheDays > 0`: for each directory `repos/<key>` whose key is not in
       `liveKeys`, delete it and its `.used` marker when the marker is missing or its mtime is older
       than `vmCacheDays` days. Also delete `.used` markers whose bucket is gone. Skip anything in
       `repos/` that `lstatSync` says is a symlink (delete the link itself with `rmSync`, never
       recurse through it).
     - Returns the deleted keys.

4. `src/runs.ts`:
   - `stepMounts(dir)` takes the run meta: `stepMounts(dir: string, meta: RunMeta)`. It mounts
     `useCacheBucket(meta)` at `/root/.cache` (`shared: true` as today) instead of the whole
     `vmCache` folder. Update its doc comment (one bucket per repo). Update every caller (search
     `stepMounts(`).
   - `NPM_CONFIG_CACHE=/root/.cache/npm` stays as it is (still inside the bucket).
   - `pruneRuns`: at its start (before the `days === 0` early return) call
     `pruneVmCache(liveKeys)` where `liveKeys` are the `cacheKey(meta)` of every run in
     `listRuns()` for which `isLive(meta)` is true; catch and ignore errors from it. Mention the
     cache pruning in the doc comment. The return value stays the deleted run names.
   - Disk watchdog in the agent step, next to `startStallWatch`:
     ```ts
     let diskError: string | undefined;
     const diskWatch = startDiskWatch({
       paths: [dir, ...(bucket ? [bucket] : [])],
       maxBytes: config.sandbox.diskMaxGb * 1024 ** 3,
       minFreeBytes: config.sandbox.minFreeGb * 1024 ** 3,
       onExceeded: (reason) => { diskError = reason; void handle.stop(); },
     });
     ```
     where `bucket` is `cacheBucket(meta)`. Stop it where `stallWatch.stop()` is called.
   - `finalStatus` gets an optional `diskError?: string`. Order: aborted, then disk, then stall,
     then time limit, then exit code, then model error. With `diskError` set it returns
     `{ status: "failed", error: diskError }`. Update its doc comment. Pass `diskError` from the step.

5. `src/diskwatch.ts` (new):
   - `export async function usedBytes(paths: string[]): Promise<number | undefined>`: runs
     `du -s -B1 -x -- <paths...>` with `execFile` (timeout 60 s, `maxBuffer` 1 MB), sums the first
     column of each line; `undefined` on any error or unparsable output. `du` does not follow
     symlinks by default; do not pass `-L`.
   - `export function freeBytes(path: string): number | undefined`: `statfsSync(path)`,
     `bavail * bsize`; `undefined` on error.
   - `export function startDiskWatch(o: { paths: string[]; maxBytes: number; minFreeBytes: number;
     onExceeded: (reason: string) => void; freeIntervalMs?: number; sizeIntervalMs?: number;
     measureUsed?: (paths: string[]) => Promise<number | undefined>; measureFree?: (path: string) =>
     number | undefined }): { stop(): void }`
     - When both limits are 0, return `{ stop() {} }`.
     - Every `freeIntervalMs` (default 15 000), when `minFreeBytes > 0`: `measureFree(paths[0])`
       (default `freeBytes`); below the floor → exceeded with
       `` `stopped: less than ${gb(minFreeBytes)} GB of disk left on this computer (HIVE_MIN_FREE_DISK_GB)` ``.
     - Every `sizeIntervalMs` (default 60 000), when `maxBytes > 0`: `await measureUsed(paths)`
       (default `usedBytes`); above the cap → exceeded with
       `` `stopped: the run used more than ${gb(maxBytes)} GB of disk (HIVE_RUN_DISK_MAX_GB)` ``.
       Never run two size checks at once (a `checking` flag, as in `src/stall.ts`).
     - An `undefined` measurement never stops a run. `onExceeded` is called at most once; after it
       (or `stop()`) both timers are cleared. Timers are `unref()`'d.
     - `gb(n)` prints whole GB (`Math.round(n / 1024 ** 3)`).

6. Tests:
   - `test/vmcache.test.mjs` (new; set `HIVE_VM_CACHE` and `HIVE_RUNS_DIR` to temp folders before
     importing `../dist/vmcache.js`; remove them at the end):
     - `cacheKey` is equal for `https://github.com/O/N.git`, `git@github.com:o/n` and
       `ssh://git@github.com/o/n`; differs between two different repos; differs between `local`
       repos at two paths; a `new` project key differs from a remote one; keys are 16 hex chars.
     - `useCacheBucket` creates `repos/<key>/` and `repos/<key>.used`; two metas of different repos
       give different buckets.
     - `pruneVmCache`: a legacy `npm/` folder and a legacy file at the cache root are deleted, a
       file outside the cache that a legacy symlink points to survives; a bucket whose marker is
       older than 30 days (set with `utimesSync`) is deleted with its marker; the same old bucket is
       kept when its key is in `liveKeys`; a fresh bucket is kept; a symlink placed in `repos/`
       pointing at an outside folder is removed and the outside folder's file survives.
   - `test/diskwatch.test.mjs` (new; imports `../dist/diskwatch.js`):
     - `usedBytes` on a temp folder with a 1 MB file returns at least 1 000 000; a symlink in it to
       a large outside file does not add the outside file's size; a missing path returns
       `undefined`.
     - `freeBytes` on the temp folder returns a positive number.
     - `startDiskWatch` with fake `measureUsed`/`measureFree` and 20 ms intervals: calls
       `onExceeded` once with the size message when used > max; once with the free-space message
       when free < floor; never when measurements are `undefined` or within limits (wait ~150 ms);
       never after `stop()`; both limits 0 returns without starting timers.
   - `test/run-status.test.mjs`: add cases: `diskError` gives `{ status: "failed", error: diskError }`;
     aborted beats `diskError`; `diskError` beats stalled and timed out.

7. Docs:
   - `docs/CONFIGURATION.md`, "Runs and the VM" table: change the `HIVE_VM_CACHE` row to say each
     repo gets its own bucket of `~/.cache` (npm, pip, Playwright, corepack), shared by that repo's
     runs only; add rows `HIVE_VM_CACHE_DAYS` (`30`), `HIVE_RUN_DISK_MAX_GB` (`20`),
     `HIVE_MIN_FREE_DISK_GB` (`2`) with the meanings from step 2. Under the table, one sentence: the
     disk limits are checked every 15 s (free space) and every minute (size), so a run can briefly
     overshoot.
   - `docs/HOW-IT-WORKS.md`: the "VM can" table row becomes "use a download cache (`~/.cache`) shared
     only with runs of the same repo"; the folder tree line becomes
     `~/.cache/agent-hive/vm-cache/repos/<id>/  ~/.cache inside the VM, one per repo`; wherever it
     lists the time limit and stall watchdog, add the disk limit.
   - `docs/ROADMAP.md`: remove item 6 ("Per-repo caches") and renumber nothing else (it is last).
   - `AGENTS.md`, security rule 6: rewrite to: the VM cache is shared between runs of the same repo
     only; each agent VM mounts `<HIVE_VM_CACHE>/repos/<cacheKey>` at `/root/.cache` (see
     `src/vmcache.ts`); it must never hold credentials or task data; the `.used` markers live
     outside the buckets; npm's cache lives inside it. Add a rule (next free number) for the disk
     watchdog: `src/diskwatch.ts` stops an agent step past `HIVE_RUN_DISK_MAX_GB` or below
     `HIVE_MIN_FREE_DISK_GB`; it measures with `du` without following symlinks. Update the layout
     table with the two new files.
   - `README.md`, "How it works" paragraph: "A time limit, a stall watchdog and a deadline note" →
     "A time limit, a stall watchdog, a disk limit and a deadline note".

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/vmcache.test.mjs test/diskwatch.test.mjs test/run-status.test.mjs` exits 0
  (after `npm run build`).
- `grep -n 'container: "/root/.cache"' src/runs.ts` prints exactly one line, and
  `grep -n 'host: config.sandbox.vmCache' src/runs.ts` prints nothing.
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
- No new dependencies. Don't change `vm/`, `image/` or `ui/`. Keep run behaviour the same apart
  from the cache location and the disk watchdog.
- Never mention pi-vm or dsh in docs.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Real filesystem quotas (loop devices, XFS project quotas), a read-only/overlay cache, cache size
  limits per bucket, UI changes.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
