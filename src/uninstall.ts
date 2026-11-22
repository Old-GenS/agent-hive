/**
 * `hive uninstall`: remove an installed hive cleanly.
 *
 * Nothing here deletes anything while the plan is being built. `uninstallPlan` describes every
 * path and profile line that would go; `runUninstall` performs exactly that plan (or only reports
 * it, with `dryRun`). Every path is computed at call time from the environment (XDG dirs, HOME,
 * HIVE_RUNS_DIR, HIVE_KEYS_FILE), as `src/release.ts` does, so tests can point them at temp
 * folders.
 *
 * Runs and saved keys/settings are kept unless the caller asks for them to go. The app's data dir
 * and the VM cache are always part of the plan; the `~/.local/bin/hive` symlink is only removed
 * when it points into the data dir (a source checkout's `npm link` symlink is left alone).
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { binLink, cacheFile, dataDir } from "./release.js";
import { keysFilePath } from "./keys.js";
import { servicePaths, uninstallService } from "./service.js";
import { isLive, listRuns } from "./runs.js";

/** The marker install-cli.sh writes on the PATH line in ~/.profile and ~/.bashrc. */
const PATH_MARKER = "added by agent-hive";

/** One thing `runUninstall` removes: what it is, where it is, and its best-effort size. */
export interface UninstallEntry {
  kind: "app" | "bin" | "cache" | "runs" | "config";
  label: string;
  path: string;
  exists: boolean;
  bytes?: number;
}

/** A profile file with `# added by agent-hive` lines: the file and the lines to drop. */
export interface PathLineFile {
  file: string;
  lines: string[];
}

/**
 * A pure description of an uninstall. `sizes` is keyed by path and only holds existing paths, so
 * a missing folder is simply absent from it.
 */
export interface UninstallPlan {
  /** The release data dir: versions, current, previous, rootfs and the channel file. */
  app: string;
  /** The `~/.local/bin/hive` symlink, when it belongs to this install. */
  bin?: string;
  /** The command symlink points somewhere else (a source checkout): leave it alone. */
  sourceInstall: boolean;
  /** The concrete paths under the cache folder that exist, never the runs folder. */
  cache: string[];
  /** The runs folder, unless runs are kept. */
  runs?: string;
  /** How many runs the runs folder holds (for the confirmation question). */
  runsCount: number;
  /** The folder holding the keys file, unless config is kept. */
  config?: string;
  /** Profile files with `added by agent-hive` lines to drop. */
  pathLines: PathLineFile[];
  /** Whether the background service (systemd unit or launchd agent) is installed. */
  service: boolean;
  /** Best-effort byte totals by path; missing paths are left out. */
  sizes: Record<string, number>;
}

function homeDir(): string {
  return resolve(homedir());
}

function cacheHome(): string {
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

function cacheRoot(): string {
  return join(cacheHome(), "agent-hive");
}

/** The runs folder, computed now so a test can move HIVE_RUNS_DIR after importing this module. */
function runsDir(): string {
  return resolve(process.env.HIVE_RUNS_DIR || join(cacheHome(), "agent-hive/runs"));
}

/** The VM cache folder, computed now (HIVE_VM_CACHE="" disables it). */
function vmCacheDir(): string | undefined {
  const raw = process.env.HIVE_VM_CACHE;
  if (raw === "") return undefined;
  return resolve(raw ?? join(cacheHome(), "agent-hive/vm-cache"));
}

/** The folder holding the keys file (`~/.config/agent-hive` by default). */
function configDir(): string {
  return dirname(resolve(keysFilePath()));
}

function isInside(path: string, parent: string): boolean {
  const p = resolve(path);
  const base = resolve(parent);
  return p === base || p.startsWith(base + sep);
}

/**
 * Refuse to remove anything that is not an absolute path strictly inside the user's home folder
 * or one of the folders hive was configured to use. Callers pass paths this module built, so this
 * is a last line of defence against a bad HOME/XDG value, not a general-purpose helper.
 */
export function assertRemovable(path: string): void {
  if (!isAbsolute(path)) throw new Error(`refusing to remove a relative path: ${path}`);
  const target = resolve(path);
  if (target === resolve(sep)) throw new Error("refusing to remove /");
  const bases = [
    homeDir(),
    process.env.XDG_DATA_HOME,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_CONFIG_HOME,
    process.env.HIVE_RUNS_DIR,
    process.env.HIVE_VM_CACHE,
    dirname(resolve(keysFilePath())),
  ]
    .filter((base): base is string => typeof base === "string" && base !== "")
    .map((base) => resolve(base));
  if (!bases.some((base) => target !== base && target.startsWith(base + sep))) {
    throw new Error(
      `refusing to remove a path outside the user's home folder and the configured hive folders: ${path}`,
    );
  }
}

/** A path's size without following symlinks: a link counts as the link itself. */
export function pathBytes(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
    let total = 0;
    for (const name of readdirSync(path)) {
      const child = pathBytes(join(path, name));
      if (child !== undefined) total += child;
    }
    return total;
  } catch {
    return undefined;
  }
}

/** Human size: `712 MB`, `1.2 GB`; one decimal below 100 of the unit. */
export function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  const units: [number, string][] = [
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
    [1024, "KB"],
  ];
  for (const [scale, unit] of units) {
    if (bytes >= scale) {
      const n = bytes / scale;
      return `${n.toFixed(n >= 100 ? 0 : 1)} ${unit}`;
    }
  }
  return `${bytes} B`;
}

/** Throws when any run is still going: deleting the app under a live run would strand it. */
export function assertNoLiveRuns(): void {
  const live = listRuns().find((run) => isLive(run.meta));
  if (live) throw new Error(`a run is still going (${live.name}); stop it first`);
}

/** The `added by agent-hive` lines in a profile file, or none when it has no such line. */
export function markedLines(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split(/\r?\n/).filter((line) => line.includes(PATH_MARKER));
}

/** Every path `runUninstall` would remove, in the order the CLI prints them. */
export function uninstallEntries(plan: UninstallPlan): UninstallEntry[] {
  const entries: UninstallEntry[] = [];
  const add = (kind: UninstallEntry["kind"], label: string, path: string): void => {
    entries.push({
      kind,
      label,
      path,
      exists: (() => {
        try {
          lstatSync(path);
          return true;
        } catch {
          return false;
        }
      })(),
      bytes: plan.sizes[path],
    });
  };
  add("app", "app and VM filesystem", plan.app);
  if (plan.bin !== undefined) add("bin", "the hive command", plan.bin);
  for (const path of plan.cache) {
    const label =
      path === resolve(cacheFile())
        ? "the update check file"
        : basenameLabel(path) === "vm-cache"
          ? "the VM cache"
          : `cache/${basenameLabel(path)}`;
    add("cache", label, path);
  }
  if (plan.runs !== undefined) add("runs", "your runs", plan.runs);
  if (plan.config !== undefined) add("config", "saved API keys and settings", plan.config);
  return entries;
}

function basenameLabel(path: string): string {
  return path.slice(path.lastIndexOf(sep) + 1);
}

/** The bin symlink: removed only when it points into the release data dir. */
function binEntry(): { bin?: string; sourceInstall: boolean } {
  const link = binLink();
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return { sourceInstall: false };
  }
  if (!stat.isSymbolicLink()) return { sourceInstall: false };
  let target: string;
  try {
    target = resolve(dirname(link), readlinkSync(link));
  } catch {
    return { sourceInstall: false };
  }
  if (isInside(target, dataDir())) return { bin: link, sourceInstall: false };
  return { sourceInstall: true };
}

/** Existing paths under the cache folder, minus the runs folder, plus an outside VM cache. */
function cacheEntries(runs: string): string[] {
  const root = cacheRoot();
  const found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    names = [];
  }
  for (const name of names) {
    const path = join(root, name);
    if (isInside(path, runs)) continue;
    found.push(path);
  }
  const vm = vmCacheDir();
  if (vm !== undefined && existsSync(vm) && !isInside(vm, root) && !isInside(vm, runs) && !found.includes(vm)) {
    found.push(vm);
  }
  found.sort();
  return found;
}

/**
 * Describe the uninstall without deleting anything. Runs and config are only listed when the
 * caller says not to keep them; the app data dir and the cache are always listed. Throws when a
 * run is still going.
 */
export function uninstallPlan(o: { keepRuns: boolean; keepConfig: boolean }): UninstallPlan {
  assertNoLiveRuns();

  const app = dataDir();
  const { bin, sourceInstall } = binEntry();
  const runs = runsDir();
  const config = configDir();
  const cache = cacheEntries(runs);

  const sizes: Record<string, number> = {};
  for (const path of [app, bin, runs, config, ...cache]) {
    if (path === undefined) continue;
    const bytes = pathBytes(path);
    if (bytes !== undefined) sizes[path] = bytes;
  }

  const pathLines: PathLineFile[] = [];
  for (const file of [join(homedir(), ".profile"), join(homedir(), ".bashrc")]) {
    const lines = markedLines(file);
    if (lines.length > 0) pathLines.push({ file, lines });
  }

  let service = false;
  try {
    service = existsSync(servicePaths().file);
  } catch {
    service = false;
  }

  return {
    app,
    bin,
    sourceInstall,
    cache,
    runs: o.keepRuns ? undefined : runs,
    runsCount: listRuns().length,
    config: o.keepConfig ? undefined : config,
    pathLines,
    service,
    sizes,
  };
}

/** Rewrite `file` without exactly the `added by agent-hive` lines, keeping every other byte. */
function stripMarkedLines(file: string): number {
  const text = readFileSync(file, "utf8");
  const kept = text.split(/(?<=\n)/).filter((line) => !line.includes(PATH_MARKER));
  const removed = text.split(/(?<=\n)/).length - kept.length;
  writeFileSync(file, kept.join(""));
  return removed;
}

/**
 * Perform the plan. Returns one line per action taken (or, with `dryRun`, the same lines prefixed
 * `would `); with `dryRun` nothing is touched. Refuses when a run is still going.
 */
export function runUninstall(
  plan: UninstallPlan,
  o: { dryRun?: boolean } = {},
): string[] {
  assertNoLiveRuns();
  const dryRun = o.dryRun === true;
  const lines: string[] = [];
  const say = (text: string): void => {
    lines.push((dryRun ? "would " : "") + text);
  };

  if (plan.service) {
    if (!dryRun) uninstallService();
    say("stop and remove the background service");
  }

  for (const entry of uninstallEntries(plan)) {
    if (!entry.exists) continue;
    assertRemovable(entry.path);
    const size = entry.bytes === undefined ? "" : ` (${sizeLabel(entry.bytes)})`;
    if (!dryRun) rmSync(entry.path, { recursive: true, force: true });
    say(`remove ${entry.path}${size}`);
  }

  for (const { file } of plan.pathLines) {
    assertRemovable(file);
    const linesBefore = markedLines(file).length;
    if (!dryRun) stripMarkedLines(file);
    say(`remove ${linesBefore} "${PATH_MARKER}" line${linesBefore === 1 ? "" : "s"} from ${file}`);
  }

  return lines;
}
