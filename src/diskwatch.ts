/**
 * Disk watchdog for an agent step: stop the run when its folder plus its cache bucket grows past
 * `HIVE_RUN_DISK_MAX_GB`, or when the disk holding the runs drops below `HIVE_MIN_FREE_DISK_GB`.
 * Size is measured with `du` without following symlinks (`-x`, so other filesystems don't count);
 * free space comes from `statfs`. A measurement that fails never stops a run.
 */
import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Bytes used by `paths`, from `du -s -k` (symlinks are not followed); undefined on any error.
 * `-k` is the block-size flag both GNU and BSD du agree on. macOS accepts `-B1` but still counts
 * 512-byte blocks, which undercounts a run by 512x and switches the size cap off.
 */
export async function usedBytes(paths: string[]): Promise<number | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("du", ["-s", "-k", "-x", "--", ...paths], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (e: any) {
    // du exits 1 when it can't read part of the tree (the agent can chmod a folder to 000) but
    // still prints the totals it could count: use them, so an unreadable folder can't switch the
    // size check off. A timeout or a missing du has no output and gives undefined.
    if (e?.killed || typeof e?.stdout !== "string" || e.stdout.trim() === "") return undefined;
    stdout = e.stdout;
  }
  if (stdout.trim().split("\n").length !== paths.length) return undefined;
  let total = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const first = line.trim().split(/\s+/)[0];
    const n = Number.parseInt(first, 10);
    if (!Number.isFinite(n)) return undefined;
    total += n * 1024; // du -k reports KiB
  }
  return total;
}

/** Free bytes on the filesystem holding `path`; undefined when it can't be read. */
export function freeBytes(path: string): number | undefined {
  try {
    const stat = statfsSync(path);
    return stat.bavail * stat.bsize;
  } catch {
    return undefined;
  }
}

/** Whole GB, for a human-readable stop reason. */
function gb(n: number): number {
  return Math.round(n / 1024 ** 3);
}

export interface DiskWatchOptions {
  /** Folders whose total size is capped: the run folder and its cache bucket. */
  paths: string[];
  /** Stop above this many bytes used; 0 turns the size check off. */
  maxBytes: number;
  /** Stop below this many bytes free; 0 turns the free-space check off. */
  minFreeBytes: number;
  /** Called at most once, with the reason the run must stop. */
  onExceeded: (reason: string) => void;
  freeIntervalMs?: number;
  sizeIntervalMs?: number;
  measureUsed?: (paths: string[]) => Promise<number | undefined>;
  measureFree?: (path: string) => number | undefined;
}

/**
 * Poll free space and the run's size; the first time a limit is crossed, call `onExceeded` once and
 * clear both timers. Timers are unref'd so they never keep the process alive. Both limits 0
 * returns a no-op watch.
 */
export function startDiskWatch(o: DiskWatchOptions): { stop(): void } {
  const measureUsed = o.measureUsed ?? usedBytes;
  const measureFree = o.measureFree ?? freeBytes;
  const freeIntervalMs = o.freeIntervalMs ?? 15_000;
  const sizeIntervalMs = o.sizeIntervalMs ?? 60_000;

  let stopped = false;
  let checking = false;
  let freeTimer: NodeJS.Timeout | undefined;
  let sizeTimer: NodeJS.Timeout | undefined;

  const stop = () => {
    stopped = true;
    if (freeTimer !== undefined) clearInterval(freeTimer);
    if (sizeTimer !== undefined) clearInterval(sizeTimer);
  };
  const exceeded = (reason: string) => {
    if (stopped) return;
    stop();
    o.onExceeded(reason);
  };

  if (o.minFreeBytes > 0) {
    freeTimer = setInterval(() => {
      if (stopped) return;
      const free = measureFree(o.paths[0]);
      if (free !== undefined && free < o.minFreeBytes) {
        exceeded(`stopped: less than ${gb(o.minFreeBytes)} GB of disk left on this computer (HIVE_MIN_FREE_DISK_GB)`);
      }
    }, freeIntervalMs);
    freeTimer.unref();
  }

  if (o.maxBytes > 0) {
    sizeTimer = setInterval(() => {
      // Never run two size checks at once: a slow du must not stack up.
      if (checking || stopped) return;
      checking = true;
      void (async () => {
        try {
          const used = await measureUsed(o.paths);
          if (!stopped && used !== undefined && used > o.maxBytes) {
            exceeded(`stopped: the run used more than ${gb(o.maxBytes)} GB of disk (HIVE_RUN_DISK_MAX_GB)`);
          }
        } finally {
          checking = false;
        }
      })();
    }, sizeIntervalMs);
    sizeTimer.unref();
  }

  return { stop };
}
