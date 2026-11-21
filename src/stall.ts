/**
 * Stall watchdog for a CLI run: stop a run when nothing in its `work/` folder changed and no agent
 * event arrived for `config.sandbox.stallMin` minutes. The file check is a single
 * `find -mmin` that stops at the first recent file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * True when a file under `dir` changed within the last `minutes` minutes. A failing check counts
 * as activity: a run is never stopped because the check itself broke.
 */
export async function changedWithin(dir: string, minutes: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("find", [dir, "-mmin", `-${minutes}`, "-print", "-quit"], {
      timeout: 60_000,
    });
    return stdout.length > 0;
  } catch {
    return true;
  }
}

/**
 * Poll `lastActivity` and the files under `dir`; the first time both are old, call `onStall` once
 * and stop. `stallMin <= 0` turns the watch off. The timer is unref'd so it never keeps the
 * process alive on its own.
 */
export function startStallWatch(o: {
  dir: string;
  stallMin: number;
  lastActivity: () => number;
  onStall: () => void;
  intervalMs?: number;
}): { stop(): void } {
  if (o.stallMin <= 0) return { stop() {} };

  let stopped = false;
  let checking = false;
  const timer = setInterval(() => {
    // Never run two checks at once: a slow find must not stack up.
    if (checking || stopped) return;
    if (Date.now() - o.lastActivity() < o.stallMin * 60_000) return;
    checking = true;
    void (async () => {
      try {
        const changed = await changedWithin(o.dir, o.stallMin);
        if (!changed && !stopped) {
          stopped = true;
          clearInterval(timer);
          o.onStall();
        }
      } finally {
        checking = false;
      }
    })();
  }, o.intervalMs ?? 60_000);
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
