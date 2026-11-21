/**
 * CLI runs. A run owns a directory:
 *
 *   <runsDir>/<repo>-<timestamp>/work      the agent's copy, mounted at /work
 *   <runsDir>/<repo>-<timestamp>/io        prompt.md, system.md, session/ (pi), events.jsonl,
 *                                          stderr.log, mounted at /io
 *   <runsDir>/<repo>-<timestamp>/out       patches exported by the sandbox (/out)
 *
 * The launcher's own stderr goes to io.launcher.log next to the io folder (never inside it).
 *
 * The VM writes its events to io/events.jsonl, never to stdout; the host follows that file.
 * The host never runs git inside work/ after prepareLocal returns.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { config, effectiveModel, PROVIDERS, providerKey, resolveProvider } from "./config.js";
import { copyVmFileOut, readVmFile, readVmFileOrEmpty, writeVmFile } from "./vmfiles.js";
import { runSandbox, type SandboxOptions } from "./sandbox.js";
import {
  applyAndPush,
  createGithubRepo,
  git,
  githubSlug,
  gitIdentity,
  isDirty,
  normalizeRepo,
  prepareLocal,
  prepareNewRepo,
  prepareRepo,
  validateBranch,
  validateRepoName,
} from "./git.js";
import type { ChangeSummary } from "./git.js";
import { followJsonl } from "./follow.js";
import { openrouterSetup } from "./openrouter.js";
import { addUsage, emptyUsage, type Usage } from "./render.js";
import { startStallWatch } from "./stall.js";
import { cacheBucket, cacheKey, pruneVmCache, useCacheBucket } from "./vmcache.js";
import { startDiskWatch } from "./diskwatch.js";

const execFileAsync = promisify(execFile);

/** Cap for the VM-written stderr.log the host reads for an error message. */
const MAX_STDERR_BYTES = 1024 * 1024;

export type RunStatus = "queued" | "running" | "done" | "failed" | "aborted";

/** How long a run waits before its one automatic retry after a dropped model connection. */
export const TRANSIENT_RETRY_DELAY_MS = 60_000;

/**
 * True when a model error looks like a dropped connection rather than the provider refusing the
 * request: a closed socket or an exhausted timeout, and nothing that names an HTTP client error,
 * an auth/key problem, a quota or a context-length limit.
 */
export function isTransientModelError(error: string | undefined): boolean {
  if (error === undefined) return false;
  if (!/UND_ERR_SOCKET|other side closed|ECONNRESET|socket hang up|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|terminated|Connection error/i.test(error)) return false;
  return !/40[0-4]|unauthori[sz]ed|invalid.{0,20}key|quota|insufficient|context length|too long/i.test(error);
}

/**
 * The run's outcome from how the sandbox ended and what pi's last assistant message said. The
 * order matters: an abort beats the disk watchdog, which beats a stall, which beats the time
 * limit, which beats the exit code.
 */
export function finalStatus(r: {
  aborted: boolean;
  timedOut: boolean;
  stalled: boolean;
  diskError?: string;
  code: number | null;
  stopReason?: string;
  modelError?: string;
  stderr: string;
  timeoutMin: number;
  stallMin: number;
}): { status: RunStatus; error?: string } {
  if (r.aborted) return { status: "aborted" };
  if (r.diskError !== undefined) return { status: "failed", error: r.diskError };
  if (r.stalled) return { status: "failed", error: `stalled: nothing changed for ${r.stallMin} minutes` };
  if (r.timedOut) return { status: "failed", error: `timed out after ${r.timeoutMin} minutes` };
  if (r.code !== 0) return { status: "failed", error: `agent exited ${r.code}: ` + r.stderr.slice(-2000) };
  if (r.stopReason === "error" || r.stopReason === "aborted") {
    const original = r.modelError || r.stopReason;
    if (isTransientModelError(r.modelError)) {
      return {
        status: "failed",
        error:
          `model error: ${original} — the provider closed the connection before answering (a busy API, or a long ` +
          "wait for the first token; many images in the conversation make that more likely). Continue the run to " +
          "pick up where it stopped.",
      };
    }
    return { status: "failed", error: "model error: " + original };
  }
  return { status: "done" };
}

export interface RunMeta {
  repo: string;
  /**
   * "local" when the run cloned the user's checkout; "remote" when it cloned a URL; "new" when it
   * started from an empty repository and creates the GitHub repo when it has commits.
   */
  source: "local" | "remote" | "new";
  base: string;
  provider: string;
  model: string;
  thinking: string;
  /** first 200 characters of the prompt */
  prompt: string;
  /** every prompt of the run (the first one, then any follow-ups), full text */
  prompts?: { text: string; at: number }[];
  status: RunStatus;
  pid: number;
  commits: number;
  usage: Usage;
  /** a new-project run's repository */
  newRepo?: { name: string; private: boolean };
  /** the GitHub repo a new-project run created, as owner/name */
  createdRepo?: string;
  reviewCycles?: number;
  reviewModel?: string;
  /** OpenRouter routing used for this run (from openrouterSetup), if any */
  routing?: unknown;
  /** the web UI's commit and file list for the run, saved when it finishes */
  changes?: ChangeSummary;
  /** agent steps run so far; earlier event logs are kept as io/events-<n>.jsonl */
  steps?: number;
  /** text of the agent's latest assistant message, written when the run ends */
  summary?: string;
  /** where `hive push` put the run's commits */
  pushed?: { branch: string; url: string; at: number };
  prUrl?: string;
  issueUrl?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

function metaPath(dir: string): string {
  return join(dir, "meta.json");
}

export function readMeta(dir: string): RunMeta {
  return JSON.parse(readFileSync(metaPath(dir), "utf8")) as RunMeta;
}

/** Write meta.json atomically: a half-written file would make the run unreadable. */
export function writeMeta(dir: string, meta: RunMeta): void {
  const tmp = metaPath(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n");
  renameSync(tmp, metaPath(dir));
}

/** Status "queued" or "running" and the process that started the VM is still alive. */
export function isLive(meta: RunMeta): boolean {
  if (meta.status !== "running" && meta.status !== "queued") return false;
  try {
    process.kill(meta.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Local-time YYYYMMDD-HHMMSS. */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** New run dir under config.runsDir; a same-second collision gets -2, -3, … */
function makeRunDir(repo: string): string {
  const base = `${basename(repo)}-${stamp()}`;
  let name = base;
  for (let n = 2; existsSync(join(config.runsDir, name)); n++) name = `${base}-${n}`;
  const dir = join(config.runsDir, name);
  mkdirSync(join(dir, "work"), { recursive: true });
  mkdirSync(join(dir, "io", "session"), { recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });
  return dir;
}

/**
 * The folders an agent step's VM shares: the run's work/ copy and, when configured, the repo's own
 * cache bucket (~/.cache). The /io share is added by runSandbox; a VM is limited to MAX_SHARES
 * folders (libkrun's interrupt slots), which is why pi's session now lives inside /io.
 */
export function stepMounts(dir: string, meta: RunMeta): SandboxOptions["mounts"] {
  const mounts: SandboxOptions["mounts"] = [{ host: join(dir, "work"), container: "/work" }];
  const bucket = useCacheBucket(meta);
  if (bucket) mounts.push({ host: bucket, container: "/root/.cache", shared: true });
  return mounts;
}

/** Newest first. Dirs without a readable meta.json are skipped. */
export function listRuns(): { name: string; dir: string; meta: RunMeta }[] {
  if (!existsSync(config.runsDir)) return [];
  const runs: { name: string; dir: string; meta: RunMeta }[] = [];
  for (const entry of readdirSync(config.runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(config.runsDir, entry.name);
    let meta: RunMeta;
    try {
      meta = readMeta(dir);
    } catch {
      continue;
    }
    runs.push({ name: entry.name, dir, meta });
  }
  return runs.sort((a, b) => b.meta.createdAt - a.meta.createdAt);
}

/** The hive-vm processes visible under procRoot: [pid, NUL-separated argv]. Unreadable entries skipped. */
function hiveVmProcs(procRoot: string): { pid: number; args: string[] }[] {
  let entries;
  try {
    entries = readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const procs: { pid: number; args: string[] }[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    let text: string;
    try {
      text = readFileSync(join(procRoot, entry.name, "cmdline"), "utf8");
    } catch {
      continue;
    }
    const args = text.split("\0").filter((arg) => arg !== "");
    if (!args.some((arg) => arg.endsWith("hive-vm"))) continue;
    procs.push({ pid: Number(entry.name), args });
  }
  return procs;
}

/**
 * Stop a VM left behind by a crashed hive and mark its run failed. For every run still marked
 * running (or queued) whose recorded owner process is gone, any `hive-vm` process whose command
 * line mentions the run's folder is sent SIGTERM and the run becomes failed. Returns the recovered
 * run names.
 */
export function recoverRuns(
  o: { procRoot?: string; kill?: (pid: number) => void } = {},
): string[] {
  const procRoot = o.procRoot ?? "/proc";
  const kill = o.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  const stale = listRuns().filter(
    ({ meta }) => (meta.status === "running" || meta.status === "queued") && !isLive(meta),
  );
  if (stale.length === 0) return [];
  const procs = hiveVmProcs(procRoot);
  const recovered: string[] = [];
  for (const { name, dir, meta } of stale) {
    for (const proc of procs) {
      if (!proc.args.some((arg) => arg.includes(dir + "/"))) continue;
      try {
        kill(proc.pid);
      } catch {
        // ESRCH: already gone.
      }
    }
    meta.status = "failed";
    meta.error = "interrupted (hive stopped)";
    meta.finishedAt = Date.now();
    writeMeta(dir, meta);
    recovered.push(name);
  }
  return recovered;
}

/**
 * Delete finished runs older than config.runRetentionDays (0 = keep forever), then prune unused
 * per-repo VM cache buckets. Returns the deleted run names.
 */
export function pruneRuns(now = Date.now()): string[] {
  try {
    const liveKeys = new Set(listRuns().filter(({ meta }) => isLive(meta)).map(({ meta }) => cacheKey(meta)));
    pruneVmCache(liveKeys);
  } catch {
    // Cache pruning is best effort: a problem there must not stop run cleanup.
  }
  const days = config.runRetentionDays;
  if (days === 0) return [];
  const cutoff = days * 86_400_000;
  const pruned: string[] = [];
  for (const { name, dir, meta } of listRuns()) {
    if (isLive(meta) || meta.finishedAt === undefined) continue;
    if (now - meta.finishedAt <= cutoff) continue;
    cleanRun(dir);
    pruned.push(name);
  }
  return pruned;
}

/**
 * Resolve `arg` to a run dir: a name under config.runsDir (no "/") or a path; no arg means the
 * newest run. Only direct children of config.runsDir count.
 */
export function resolveRun(arg?: string): string {
  if (arg === undefined) {
    const newest = listRuns()[0];
    if (!newest) throw new Error("no runs");
    return newest.dir;
  }
  let real: string;
  let realRuns: string;
  try {
    real = realpathSync(arg.includes("/") ? arg : join(config.runsDir, arg));
    realRuns = realpathSync(config.runsDir);
  } catch {
    throw new Error("not a run: " + arg);
  }
  if (dirname(real) !== realRuns || !existsSync(metaPath(real))) throw new Error("not a run: " + arg);
  return real;
}

export function cleanRun(dir: string): void {
  if (isLive(readMeta(dir))) throw new Error(`run is still going: ${basename(dir)}`);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Absolute paths of out/*.patch, sorted. Only regular files count: out/ is VM-writable, so an
 * entry can be a symlink the agent planted to make host git read a host file as a patch.
 */
export function patchFiles(dir: string): string[] {
  const out = join(dir, "out");
  if (!existsSync(out)) return [];
  const files: string[] = [];
  for (const name of readdirSync(out)) {
    if (!name.endsWith(".patch")) continue;
    const path = join(out, name);
    try {
      if (!lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    files.push(path);
  }
  return files.sort();
}

/**
 * Export whatever the agent committed in work/: clear out/, run hive-export in a VM with the
 * run's base commit, then count the patches. Runs in a VM because the host never runs git in
 * work/. `ok` is false when the export failed; the caller decides what that means.
 */
async function exportPatches(
  dir: string,
  meta: RunMeta,
): Promise<{ ok: boolean; code: number; commits: number }> {
  const out = join(dir, "out");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  const exp = await runSandbox({
    name: "hive-" + basename(dir) + "-export",
    mounts: [
      { host: join(dir, "work"), container: "/work" },
      { host: out, container: "/out" },
    ],
    env: gitIdentity(),
    command: ["hive-export", meta.base],
    // Its own folder, so the export never touches the agent's event log (hive log reads it).
    ioDir: join(dir, "io-export"),
  });
  const r = await exp.done;
  if (r.code !== 0) return { ok: false, code: r.code ?? -1, commits: 0 };
  return { ok: true, code: 0, commits: patchFiles(dir).length };
}

/**
 * Whether a finished step should get its review cycles: only a done step with cycles left and
 * work to look at. `commits` is undefined when the export failed, and then reviews run as before.
 */
export function shouldReview(o: { status: RunStatus; cycles: number; commits: number | undefined }): boolean {
  return o.status === "done" && o.cycles > 0 && o.commits !== 0;
}

/** Throttle for saving meta.usage while the agent runs: at most once every 5 seconds, on change. */
export function usageWriteDue(now: number, last: number, changed: boolean): boolean {
  return changed && now - last >= 5000;
}

/** Patch text, or `git apply --stat` output; "" when the run produced no commits. */
export async function diffRun(dir: string, stat: boolean): Promise<string> {
  const patches = patchFiles(dir);
  if (patches.length === 0) return "";
  if (stat) return await git(["apply", "--stat", ...patches], dir);
  return patches.map((p) => readVmFile(p)).join("");
}

/**
 * Apply a finished run's patches to the user's repo: directly to the work tree when HEAD is
 * still the run's base, or as commits on a new branch from the base.
 */
export async function applyRun(dir: string, repo: string, branch?: string): Promise<string> {
  const meta = readMeta(dir);
  if (meta.source === "remote") throw new Error("this run is from " + meta.repo + "; use hive push");
  if (meta.status !== "done") throw new Error(`run is ${meta.status}; nothing to apply`);
  if (!(meta.commits > 0)) throw new Error("nothing to apply");
  if (realpathSync(repo) !== realpathSync(meta.repo)) throw new Error(`this run belongs to ${meta.repo}`);
  if (await isDirty(repo)) throw new Error("repo has uncommitted changes; commit or stash first");
  const patches = patchFiles(dir);
  // out/ is VM-writable: copy the patches to a host-only folder first, so host git never reads a
  // path the agent could have replaced with a symlink to a host file.
  const patchDir = mkdtempSync(join(tmpdir(), "hive-apply-"));
  try {
    const copies = patches.map((patch) => {
      const copy = join(patchDir, basename(patch));
      copyVmFileOut(patch, copy);
      return copy;
    });

    if (!branch) {
      const head = await git(["rev-parse", "HEAD"], repo);
      if (head !== meta.base) throw new Error("repo HEAD moved since the run; use --branch");
      await git(["apply", ...copies], repo);
      return await git(["status", "--short"], repo);
    }

    validateBranch(branch);
    let exists = true;
    try {
      await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    } catch {
      exists = false;
    }
    if (exists) throw new Error(`branch ${branch} already exists`);
    await git(["switch", "-q", "-c", branch, meta.base], repo);
    try {
      await git(["am", "-q", "--keep-cr", ...copies], repo, 120_000);
    } catch (err) {
      await git(["am", "--abort"], repo).catch(() => {});
      throw err;
    }
    return `on branch ${branch}: ${meta.commits} commit(s)`;
  } finally {
    rmSync(patchDir, { recursive: true, force: true });
  }
}

/**
 * Build a downloadable result from a finished run's exported patches: a zip of the project files
 * or a git bundle of its commits. Like a push, this applies the patches to a fresh clone of the
 * trusted source on the host; it never reads, copies or runs git in <run>/work, whose .git the
 * agent controls.
 */
export async function exportRun(
  dir: string,
  format: "zip" | "bundle",
  outPath: string,
): Promise<{ path: string; commits: number }> {
  const meta = readMeta(dir);
  if (isLive(meta)) throw new Error("run is still going");
  const patches = patchFiles(dir);
  if (patches.length === 0) throw new Error("no commits to export");

  // A remote or new-project run keeps the pristine clone in origin/, as does a local run after
  // `hive push`; a local run without one falls back to the user's own checkout.
  const origin = join(dir, "origin");
  const source = existsSync(origin) ? origin : meta.repo;
  const runName = basename(dir);
  const tmp = mkdtempSync(join(tmpdir(), "hive-export-"));
  try {
    // out/ is VM-writable: copy the patches into this host-only folder first, and let git read
    // only the copies, never a path the agent could have replaced with a symlink.
    const patchDir = join(tmp, "patches");
    mkdirSync(patchDir);
    const copies = patches.map((patch) => {
      const copy = join(patchDir, basename(patch));
      copyVmFileOut(patch, copy);
      return copy;
    });
    const repo = join(tmp, "repo");
    await git(["clone", "-q", "--no-hardlinks", "--no-checkout", "--", source, repo], undefined, 120_000);
    try {
      await git(["cat-file", "-e", `${meta.base}^{commit}`], repo);
    } catch {
      throw new Error(`the run's base commit is no longer in ${source}`);
    }
    await git(["checkout", "-q", "-B", "hive-export", meta.base], repo);
    const ident = ["-c", `user.name=${config.git.authorName}`, "-c", `user.email=${config.git.authorEmail}`];
    try {
      await git([...ident, "am", "-q", "--keep-cr", ...copies], repo, 120_000);
    } catch (err) {
      await git(["am", "--abort"], repo).catch(() => {});
      throw new Error(`couldn't apply the run's commits: ${(err as Error).message}`);
    }

    if (format === "zip") {
      const repoName = runName.replace(/-\d{8}-\d{6}(-\d+)?$/, "") || "project";
      await git(["archive", "--format=zip", `--prefix=${repoName}/`, "-o", outPath, "hive-export"], repo);
    } else {
      const branch = "hive/" + runName;
      await git(["branch", "-M", branch], repo);
      // HEAD rides along so a plain `git clone <file>.bundle` checks the branch out.
      await git(["bundle", "create", outPath, branch, "HEAD"], repo, 120_000);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { path: outPath, commits: patches.length };
}

/**
 * A run's facts as a Markdown report, built only from its meta.json: the first prompt's first line
 * as the title, a facts table, every prompt, the agent's final report, its error and the commits
 * and files the run made. Pure, so the CLI, the web route and the tests all share it.
 */
export function reportMarkdown(name: string, meta: RunMeta): string {
  const prompts: { text: string; at: number | undefined }[] = meta.prompts?.length
    ? meta.prompts
    : [{ text: meta.prompt, at: undefined }];
  const title = (prompts[0].text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 120);

  const rows: [string, string][] = [
    ["Run", name],
    [
      "Repository",
      meta.createdRepo ??
        (meta.repo || (meta.newRepo ? `new project ${meta.newRepo.name}` : "")),
    ],
    ["Status", meta.status === "aborted" ? "stopped" : meta.status === "queued" ? "running" : meta.status],
    ["Model", `${meta.provider} · ${meta.model} · thinking ${meta.thinking}`],
    ["Started", isoNoMillis(meta.createdAt)],
    ["Finished", meta.finishedAt === undefined ? "—" : isoNoMillis(meta.finishedAt)],
    [
      "Duration",
      meta.finishedAt === undefined ? "—" : durationText(meta.finishedAt - meta.createdAt),
    ],
    [
      "Cost",
      `$${meta.usage.cost.toFixed(4)} (${meta.usage.input} in / ${meta.usage.output} out tokens)`,
    ],
    ["Commits", String(meta.commits)],
  ];
  if (meta.pushed) rows.push(["Branch", meta.pushed.branch]);
  if (meta.prUrl) rows.push(["Pull request", meta.prUrl]);

  const parts: string[] = [`# ${title}`, "", "| | |", "|---|---|"];
  for (const [label, value] of rows) parts.push(`| ${label} | ${tableCell(value)} |`);

  parts.push("");
  if (prompts.length > 1) {
    parts.push("## Prompts");
    prompts.forEach((prompt, index) => {
      parts.push("", `### ${index + 1} — ${prompt.at === undefined ? "—" : isoNoMillis(prompt.at)}`, "", prompt.text);
    });
  } else {
    parts.push("## Prompt", "", prompts[0].text);
  }

  parts.push("", "## Report", "", meta.summary ?? "_The agent left no report._");

  if (meta.error !== undefined) {
    const fence = fenceFor(meta.error);
    parts.push("", "## Error", "", `${fence}\n${meta.error}\n${fence}`);
  }

  if (meta.changes?.commits.length) {
    parts.push("", "## Commits", "", ...meta.changes.commits.map((subject) => `- ${subject}`));
  }

  if (meta.changes?.files.length) {
    parts.push("", "## Files changed", "");
    for (const file of meta.changes.files) {
      const stats = file.added === null || file.removed === null ? "binary" : `+${file.added} −${file.removed}`;
      parts.push(`- \`${file.path}\` (${stats})`);
    }
  }

  return parts.join("\n") + "\n";
}

/** YYYY-MM-DDTHH:MM:SSZ, without milliseconds. */
function isoNoMillis(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** "12 min 3 s", "3 s". */
function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

/** A table cell: pipes escaped and newlines flattened, so the row keeps its shape. */
function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A code fence longer than any run of backticks in the content (at least three). */
function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Write a finished run's Markdown report to `outPath`; refuses while the run is still going. */
export function exportReport(dir: string, outPath: string): { path: string } {
  const meta = readMeta(dir);
  if (isLive(meta)) throw new Error("run is still going");
  writeFileSync(outPath, reportMarkdown(basename(dir), meta));
  return { path: outPath };
}

/** Subject of the first `Subject: ` line in a format-patch file, with the `[PATCH …]` tag off. */
export function patchSubject(patchText: string): string {
  const line = patchText.split("\n").find((l) => l.startsWith("Subject: "));
  if (line === undefined) return "";
  return line
    .slice("Subject: ".length)
    .replace(/^\[PATCH[^\]]*\]\s*/, "")
    .trim();
}

/** `gh pr create` arguments for a pushed run. */
export function prArgs(o: {
  slug: string;
  branch: string;
  title: string;
  body: string;
  base?: string;
}): string[] {
  const args = ["pr", "create", "--repo", o.slug, "--head", o.branch, "--title", o.title, "--body", o.body];
  if (o.base) args.push("--base", o.base);
  return args;
}

/**
 * Put a finished run's commits on a branch in the repo's push remote with the user's own git
 * credentials (never forced). Remote runs push back to the URL they were cloned from.
 *
 * `update` re-pushes the branch a run already pushed (a follow-up rewrites that branch, which
 * belongs to the run). New-project runs create the GitHub repo first, then push to `main`.
 */
export async function pushRun(
  dir: string,
  o: { branch?: string; remote?: string; requireGithub?: boolean; update?: boolean } = {},
): Promise<{ branch: string; url: string; commits: number }> {
  const meta = readMeta(dir);
  if (meta.status !== "done") throw new Error(`run is ${meta.status}; nothing to push`);

  // A follow-up run owns the branch an earlier prompt pushed; force-update it.
  if (o.update && meta.pushed) {
    const pushed = meta.pushed;
    let commits: number;
    try {
      commits = await applyAndPush(dir, meta.base, pushed.branch, true);
    } catch (err) {
      throw new Error(`${(err as Error).message} (check your git credentials for ${pushed.url})`);
    }
    meta.pushed = { ...pushed, at: Date.now() };
    writeMeta(dir, meta);
    return { branch: pushed.branch, url: pushed.url, commits };
  }

  if (meta.source === "new") {
    // No commits, no repository.
    if (!(meta.commits > 0)) return { branch: "main", url: "", commits: 0 };
    let url: string;
    if (!meta.createdRepo) {
      const slug = await createGithubRepo(meta.newRepo!.name, meta.newRepo!.private);
      url = normalizeRepo(slug).url;
      await git(["remote", "add", "origin", url], join(dir, "origin"));
      meta.createdRepo = slug;
    } else {
      url = normalizeRepo(meta.createdRepo).url;
    }
    let commits: number;
    try {
      commits = await applyAndPush(dir, meta.base, "main", true);
    } catch (err) {
      throw new Error(`${(err as Error).message} (check your git credentials for ${url})`);
    }
    meta.pushed = { branch: "main", url, at: Date.now() };
    writeMeta(dir, meta);
    return { branch: "main", url, commits };
  }

  if (!(meta.commits > 0)) throw new Error("nothing to push");
  const branch = validateBranch(o.branch ?? config.git.branchPrefix + basename(dir));

  let url: string;
  if (meta.source === "remote") {
    url = await git(["remote", "get-url", "origin"], join(dir, "origin"));
  } else {
    const remoteName = o.remote ?? config.git.pushRemote;
    try {
      url = await git(["remote", "get-url", "--push", remoteName], meta.repo);
    } catch {
      throw new Error(`repo ${meta.repo} has no remote "${remoteName}"`);
    }
    rmSync(join(dir, "origin"), { recursive: true, force: true });
    await git(["clone", "-q", "--no-hardlinks", "--", meta.repo, join(dir, "origin")]);
    await git(["remote", "set-url", "origin", url], join(dir, "origin"));
    try {
      await git(["cat-file", "-e", `${meta.base}^{commit}`], join(dir, "origin"));
    } catch {
      throw new Error(`the run's base commit is no longer in ${meta.repo}`);
    }
  }

  // Checked before anything is pushed, so `--pr` on a non-GitHub remote leaves no stray branch.
  if (o.requireGithub && !githubSlug(url)) {
    throw new Error(`pull requests need a github.com remote (this run pushes to ${url})`);
  }
  // Never overwrite: a branch that already exists (e.g. from an earlier push) is an error.
  let existing: string;
  try {
    existing = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], join(dir, "origin"), 120_000);
  } catch (err) {
    throw new Error(`couldn't reach ${url}: ${(err as Error).message} (check your git credentials)`);
  }
  if (existing) {
    throw new Error(`branch ${branch} already exists on ${url}; pick another name with --branch`);
  }

  let commits: number;
  try {
    commits = await applyAndPush(dir, meta.base, branch, false);
  } catch (err) {
    throw new Error(`${(err as Error).message} (check your git credentials for ${url})`);
  }
  meta.pushed = { branch, url, at: Date.now() };
  writeMeta(dir, meta);
  return { branch, url, commits };
}

/** Open a GitHub pull request for a pushed run through the user's `gh` login. */
export async function openPr(dir: string, o: { base?: string } = {}): Promise<string> {
  const meta = readMeta(dir);
  if (!meta.pushed) throw new Error("push the run first");
  const slug = githubSlug(meta.pushed.url);
  if (!slug) throw new Error(`pull requests need a github.com remote (pushed to ${meta.pushed.url})`);

  const first = patchFiles(dir)[0];
  let title = first ? patchSubject(readVmFile(first)) : "";
  if (!title) title = meta.prompt.slice(0, 70);
  const body = meta.summary ?? title;

  let stdout: string;
  try {
    const result = await execFileAsync(
      "gh",
      prArgs({ slug, branch: meta.pushed.branch, title, body, base: o.base }),
      { timeout: 120_000 },
    );
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (e.code === "ENOENT") {
      throw new Error("gh is not installed; install the GitHub CLI and run gh auth login to open pull requests");
    }
    const detail = e.stderr ? String(e.stderr) : e.message;
    throw new Error(`gh pr create failed: ${detail.trim()}`);
  }

  const prUrl = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  meta.prUrl = prUrl;
  writeMeta(dir, meta);
  return prUrl;
}

export interface StartRunOptions {
  /** Local repo to clone; exactly one of repo, remote or newRepo. */
  repo?: string;
  /** Remote repo to clone; exactly one of repo, remote or newRepo. */
  remote?: { url: string; name: string; ref?: string };
  /** Start from an empty repo and create the GitHub repo when the run has commits. */
  newRepo?: { name: string; private?: boolean };
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: string;
  /** replaces config.systemPrompt for this run */
  systemPrompt?: string;
  reviewCycles?: number;
  reviewModel?: string;
  onEvent: (e: any) => void;
  signal: AbortSignal;
  /** Called once the run dir and meta.json exist and the run's status is "queued". */
  onStart?: (dir: string, meta: RunMeta) => void;
  /** Called just before each step the run enters (cloning, running, reviewing, …). */
  onStatus?: (status: string, extra?: Record<string, unknown>) => void;
  /** Waits for a free run slot; rejects (or abort is signalled) when the run is aborted while queued. */
  waitTurn?: (signal: AbortSignal) => Promise<void>;
}

/**
 * Run pi on the current repo inside a libkrun microVM. Throws only on errors before the VM
 * starts; afterwards the outcome is recorded in meta.json and returned.
 */
export async function startRun(o: StartRunOptions): Promise<{ dir: string; meta: RunMeta }> {
  const sources = [o.repo !== undefined, o.remote !== undefined, o.newRepo !== undefined].filter(Boolean).length;
  if (sources !== 1) throw new Error("startRun needs exactly one of repo, remote or newRepo");
  let newRepo: { name: string; private: boolean } | undefined;
  if (o.newRepo !== undefined) {
    newRepo = { name: validateRepoName(o.newRepo.name), private: o.newRepo.private !== false };
  }

  const provider = resolveProvider(o.provider);
  if (!provider || !PROVIDERS[provider]) {
    throw new Error(`Unknown or missing provider. Supported: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  const key = providerKey(provider);
  if (!key) throw new Error(`No API key configured for provider "${provider}"`);
  const model = o.model || effectiveModel(provider);
  if (!model) throw new Error(`model is required for provider "${provider}" (or set DEFAULT_MODEL)`);
  const thinking = o.thinking || config.defaultThinking;
  if (!THINKING.includes(thinking)) throw new Error(`thinkingLevel must be one of ${THINKING.join(", ")}`);
  const cycles = o.reviewCycles ?? 0;
  if (!Number.isInteger(cycles) || cycles < 0 || cycles > 5) throw new Error("reviewCycles must be 0-5");

  // OpenRouter routing needs its model list and provider ranking first: an error here rejects the
  // run before anything is created on disk.
  let openrouter: { modelsJson: any; routing: any; note?: string } | undefined;
  if (provider === "openrouter") {
    openrouter = await openrouterSetup(model, config.openrouterRouting);
  }

  const dir = makeRunDir(newRepo ? newRepo.name : (o.remote ? o.remote.name : (o.repo as string)));
  const meta: RunMeta = {
    repo: o.remote ? o.remote.url : newRepo ? "" : (o.repo as string),
    source: newRepo ? "new" : o.remote ? "remote" : "local",
    base: "",
    provider,
    model,
    thinking,
    prompt: o.prompt.slice(0, 200),
    prompts: [{ text: o.prompt, at: Date.now() }],
    status: "queued",
    pid: process.pid,
    commits: 0,
    usage: emptyUsage(),
    createdAt: Date.now(),
  };
  if (newRepo) meta.newRepo = newRepo;
  if (cycles > 0) meta.reviewCycles = cycles;
  if (o.reviewModel !== undefined) meta.reviewModel = o.reviewModel;
  if (openrouter) {
    meta.routing = openrouter.routing;
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(join(dir, "agent", "models.json"), JSON.stringify(openrouter.modelsJson, null, 2));
    writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ enableInstallTelemetry: false }, null, 2));
  }
  writeMeta(dir, meta);
  o.onStart?.(dir, meta);
  if (openrouter?.note !== undefined) o.onEvent({ type: "hive_note", text: openrouter.note });

  try {
    await o.waitTurn?.(o.signal);
  } catch (err) {
    if (!o.signal.aborted) throw err;
  }
  if (o.signal.aborted) {
    meta.status = "aborted";
    meta.finishedAt = Date.now();
    writeMeta(dir, meta);
    return { dir, meta };
  }

  try {
    o.onStatus?.("cloning", newRepo ? { newProject: true } : {});
    meta.base = newRepo
      ? await prepareNewRepo(dir)
      : o.remote
        ? await prepareRepo(dir, o.remote.url, o.remote.ref)
        : await prepareLocal(o.repo as string, join(dir, "work"));
  } catch (err) {
    markFailed(dir, meta, err);
    throw err;
  }
  meta.status = "running";
  writeMeta(dir, meta);

  // Host-only: the run folder is not mounted into any VM, so an agent can't replace it with a
  // symlink the next step would read.
  writeFileSync(join(dir, "system-base.md"), o.systemPrompt || config.systemPrompt);

  const prefix = newRepo
    ? `/work is an empty git repository for a new project. Create the project there and commit your work with clear messages. You cannot push; when you finish, hive creates the GitHub repository ${newRepo.name} and pushes your commits to it.\n\n`
    : "";
  return runSteps(dir, meta, prefix + o.prompt, {
    continueSession: false,
    signal: o.signal,
    onEvent: o.onEvent,
    onStatus: o.onStatus,
  });
}

export interface ContinueRunOptions {
  prompt: string;
  signal: AbortSignal;
  onEvent: (e: any) => void;
  onStatus?: (status: string, extra?: Record<string, unknown>) => void;
  waitTurn?: (signal: AbortSignal) => Promise<void>;
}

/**
 * Continue a finished run in the same pi session and on the same work copy. Pushing is left to
 * `hive push` (or the web UI's finish step), as for a first prompt.
 */
export async function continueRun(dir: string, o: ContinueRunOptions): Promise<{ dir: string; meta: RunMeta }> {
  const meta = readMeta(dir);
  if (isLive(meta)) throw new Error("run is still going");
  if (!existsSync(join(dir, "work"))) throw new Error("run has no work folder");

  meta.status = "queued";
  meta.pid = process.pid;
  meta.prompts = [...(meta.prompts ?? []), { text: o.prompt, at: Date.now() }];
  delete meta.error;
  delete meta.finishedAt;
  writeMeta(dir, meta);

  try {
    await o.waitTurn?.(o.signal);
  } catch (err) {
    if (!o.signal.aborted) throw err;
  }
  if (o.signal.aborted) {
    meta.status = "aborted";
    meta.finishedAt = Date.now();
    writeMeta(dir, meta);
    return { dir, meta };
  }

  meta.status = "running";
  writeMeta(dir, meta);
  return runSteps(dir, meta, o.prompt, {
    continueSession: true,
    signal: o.signal,
    onEvent: o.onEvent,
    onStatus: o.onStatus,
  });
}

/**
 * The note appended to the agent's system prompt for every step: its deadline, so it commits in
 * time instead of running out of time with everything uncommitted.
 */
export function timeNote(minutes: number, start: Date): string {
  const deadline = new Date(start.getTime() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `This run has a time limit of ${minutes} minutes and is stopped at ${deadline} (UTC; check with ` +
    "`date -u`). Commit as you go. When 10 minutes are left, start no new work: commit what you " +
    "have and finish."
  );
}

/**
 * Drop streaming-only events from a saved event log: `message_update` and `tool_execution_update`
 * only matter while the run is live. Lines that don't parse are kept as they are.
 */
export function slimEvents(text: string): string {
  const kept = text
    .split("\n")
    .filter((line) => {
      if (line.trim() === "") return true;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return true;
      }
      return event?.type !== "message_update" && event?.type !== "tool_execution_update";
    })
    .join("\n");
  return text.endsWith("\n") && !kept.endsWith("\n") ? kept + "\n" : kept;
}

/**
 * Drop streaming-only events from a step's saved event log (the live stream is over and a replay
 * rebuilds assistant text from message_end). io/ is VM-writable, so the read and the write go
 * through src/vmfiles.ts; on any refusal the log is left exactly as it is.
 */
export function slimStepLog(dir: string): void {
  try {
    const log = join(dir, "io", "events.jsonl");
    writeVmFile(log, slimEvents(readVmFileOrEmpty(log)));
  } catch {
    // Leave the log alone: it is already inside io/, and it is only a replay aid.
  }
}

/**
 * Write a step's io/system.md (the base prompt plus this step's deadline) and io/prompt.md. Both
 * names are VM-shared, so writeVmFile replaces any symlink the previous step planted. The base
 * prompt itself is host-only (<run>/system-base.md): it is never read from io/.
 */
export function prepareStepFiles(dir: string, _meta: RunMeta, prompt: string): void {
  let systemBase: string;
  try {
    systemBase = readFileSync(join(dir, "system-base.md"), "utf8");
  } catch {
    // An older run has no host-only base prompt: use the configured default. Never look in io/:
    // the VM controls that folder and could have pointed it at a host file.
    systemBase = config.systemPrompt;
  }
  writeVmFile(join(dir, "io", "system.md"), systemBase + "\n\n" + timeNote(config.sandbox.timeoutMin, new Date()));
  writeVmFile(join(dir, "io", "prompt.md"), prompt);
}

/** One agent step's outcome. */
interface AgentStepResult {
  status: RunStatus;
  error?: string;
  summary?: string;
  lastText: string;
}

interface AgentStepOptions {
  prompt: string;
  model: string;
  session: "new" | "continue" | "none";
  signal: AbortSignal;
  onEvent: (e: any) => void;
}

/** Run pi once in a fresh microVM, on the run's work/ copy. */
async function agentStep(dir: string, meta: RunMeta, o: AgentStepOptions): Promise<AgentStepResult> {
  // Keep earlier steps' logs: only the latest is io/events.jsonl, which `hive log` follows.
  const steps = meta.steps ?? 0;
  if (steps >= 1) {
    const ioDir = join(dir, "io");
    for (const [from, to] of [
      [join(ioDir, "events.jsonl"), join(ioDir, `events-${steps}.jsonl`)],
      [join(ioDir, "stderr.log"), join(ioDir, `stderr-${steps}.log`)],
    ]) {
      if (existsSync(from)) renameSync(from, to);
    }
  }
  meta.steps = steps + 1;

  // The base prompt is written once, at startRun, to the host-only run folder; each step appends
  // its own deadline to a fresh io/system.md so the agent knows the clock.
  prepareStepFiles(dir, meta, o.prompt);

  // pi's session lives on the io share now (a VM share costs an interrupt slot). Runs made before
  // this change keep their history in <run>/session: move it over once. If both exist, io wins.
  const oldSession = join(dir, "session");
  const sessionDir = join(dir, "io", "session");
  if (existsSync(oldSession) && !existsSync(sessionDir)) renameSync(oldSession, sessionDir);
  mkdirSync(sessionDir, { recursive: true });

  const mounts = stepMounts(dir, meta);
  // An OpenRouter run's models.json and settings.json live in <run>/agent. pi writes lock and
  // state files into its config folder, so each step gets a fresh writable copy in its io folder
  // (/io/pi-agent): whatever pi changes there is thrown away before the next step. It rides on the
  // io share rather than a share of its own: the VM doesn't boot with one more share than a
  // normal run already uses. rmSync removes a planted symlink with the old copy without following
  // it, and the cpSync below runs before any VM exists for this step, so nothing is between the
  // two that could swap the folder for a link.
  const agentDir = join(dir, "agent");
  const useAgentDir = meta.provider === "openrouter" && existsSync(agentDir);
  if (useAgentDir) {
    const agentVm = join(dir, "io", "pi-agent");
    rmSync(agentVm, { recursive: true, force: true });
    cpSync(agentDir, agentVm, { recursive: true });
  }
  const sessionArgs =
    o.session === "none" ? ["--no-session"] : o.session === "continue" ? ["--session-dir", "/io/session", "--continue"] : ["--session-dir", "/io/session"];
  const command = [
    "hive-agent",
    "-p",
    "--provider", meta.provider,
    "--model", o.model,
    "--thinking", meta.thinking,
    ...sessionArgs,
    "--append-system-prompt", "/io/system.md",
    "@/io/prompt.md",
    "Do the task described in the attached file prompt.md.",
  ];

  const key = providerKey(meta.provider)!;
  const env: Record<string, string> = { [PROVIDERS[meta.provider].sandboxEnv]: key, ...gitIdentity() };
  if (useAgentDir) env.PI_CODING_AGENT_DIR = "/io/pi-agent";
  // npm downloads live in the repo's cache bucket, which is mounted at ~/.cache.
  if (config.sandbox.vmCache) env.NPM_CONFIG_CACHE = "/root/.cache/npm";
  const handle = await runSandbox({
    name: "hive-" + basename(dir),
    mounts,
    env,
    command,
    ioDir: join(dir, "io"),
  });

  let lastText = "";
  let lastActivity = Date.now();
  let stopReason: string | undefined;
  let modelError: string | undefined;
  // Save meta.usage while the run goes (the run list and `hive list` show it live), at most every
  // 5 seconds and only when the cost changed. The final write happens when the run ends.
  let lastUsageWrite = 0;
  let writtenCost = meta.usage.cost;
  const follower = followJsonl(join(dir, "io", "events.jsonl"), (e) => {
    lastActivity = Date.now();
    addUsage(meta.usage, e);
    const now = Date.now();
    if (usageWriteDue(now, lastUsageWrite, meta.usage.cost !== writtenCost)) {
      lastUsageWrite = now;
      writtenCost = meta.usage.cost;
      writeMeta(dir, meta);
    }
    if (e?.type === "message_end" && e.message?.role === "assistant") {
      stopReason = e.message.stopReason;
      modelError = e.message.errorMessage;
      const text = (Array.isArray(e.message.content) ? e.message.content : [])
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
      if (text) lastText = text;
    }
    o.onEvent(e);
  });
  // Stop a run that went quiet: nothing in work/ changed and no event arrived for stallMin minutes.
  let stalled = false;
  const stallWatch = startStallWatch({
    dir: join(dir, "work"),
    stallMin: config.sandbox.stallMin,
    lastActivity: () => lastActivity,
    onStall: () => {
      stalled = true;
      void handle.stop();
    },
  });
  // Stop a run that outgrows its disk budget: the run folder plus its cache bucket, and the free
  // space on the disk holding them.
  let diskError: string | undefined;
  const bucket = cacheBucket(meta);
  const diskWatch = startDiskWatch({
    paths: [dir, ...(bucket ? [bucket] : [])],
    maxBytes: config.sandbox.diskMaxGb * 1024 ** 3,
    minFreeBytes: config.sandbox.minFreeGb * 1024 ** 3,
    onExceeded: (reason) => {
      diskError = reason;
      void handle.stop();
    },
  });
  const onAbort = () => {
    void handle.stop();
  };
  if (o.signal.aborted) onAbort();
  else o.signal.addEventListener("abort", onAbort, { once: true });

  const result = await handle.done;
  follower.stop();
  stallWatch.stop();
  diskWatch.stop();
  o.signal.removeEventListener("abort", onAbort);

  // The VM has exited: drop streaming-only events from the saved log (the live stream is over and
  // a replay rebuilds assistant text from message_end). io/ is VM-writable, so the read/write go
  // through src/vmfiles.ts and a log it refuses is left as it is.
  slimStepLog(dir);

  let stderrText = "";
  try {
    stderrText = readVmFileOrEmpty(join(dir, "io", "stderr.log"), MAX_STDERR_BYTES);
  } catch {
    // unreadable or too large: fall back to what the launcher kept
  }
  if (!stderrText) stderrText = result.stderr;
  const outcome = finalStatus({
    aborted: o.signal.aborted,
    timedOut: result.timedOut,
    stalled,
    diskError,
    code: result.code,
    stopReason,
    modelError,
    stderr: stderrText,
    timeoutMin: config.sandbox.timeoutMin,
    stallMin: config.sandbox.stallMin,
  });
  return {
    status: outcome.status,
    error: outcome.error,
    summary: lastText || undefined,
    lastText,
  };
}

export const REVIEW_PROMPT = (task: string, base: string) => `You are reviewing changes another agent just made in this repository.

The task they were given:
<task>
${task}
</task>

Run \`git diff ${base}\` (and \`git status\` for new files) to see every change since commit ${base}.
Check for bugs, security problems, unhandled edge cases, and whether the change does what the
task asked. Read the surrounding code where needed and run the project's tests or build if it
has them.

Fix every real problem directly in the files and commit the fixes with a message starting
"review:". Do not make stylistic or speculative changes. If nothing needs fixing, change nothing
and reply with a first line of exactly: LGTM`;

/** True when a reviewer said it found nothing to fix. */
export function isLgtm(text: string): boolean {
  return /^\s*LGTM\b/i.test(text);
}

interface RunStepsOptions {
  continueSession: boolean;
  signal: AbortSignal;
  onEvent: (e: any) => void;
  onStatus?: (status: string, extra?: Record<string, unknown>) => void;
  /** How long the one automatic retry waits after a dropped model connection; tests set 0. */
  retryDelayMs?: number;
  /** Test hook: the function that runs one agent step. */
  agentStep?: typeof agentStep;
}

/** The prompt of a run's one automatic retry after the model connection dropped. */
const TRANSIENT_RETRY_PROMPT =
  "The last model request failed because the connection dropped. Continue the task from where you left off; don't redo finished work.";

/** Wait for ms or until the signal aborts, whichever comes first. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The shared pipeline for a first prompt and a follow-up: the main agent step, optional review
 * cycles, then export whatever was committed (always, whatever the outcome) and record the result.
 */
/** Record an unexpected error so the run never stays "running" or "queued". */
function markFailed(dir: string, meta: RunMeta, err: unknown): void {
  meta.status = "failed";
  meta.error = (err as Error)?.message ?? String(err);
  meta.finishedAt = Date.now();
  writeMeta(dir, meta);
}

export async function runSteps(
  dir: string,
  meta: RunMeta,
  prompt: string,
  o: RunStepsOptions,
): Promise<{ dir: string; meta: RunMeta }> {
  try {
    return await runStepsInner(dir, meta, prompt, o);
  } catch (err) {
    markFailed(dir, meta, err);
    throw err;
  }
}

async function runStepsInner(
  dir: string,
  meta: RunMeta,
  prompt: string,
  o: RunStepsOptions,
): Promise<{ dir: string; meta: RunMeta }> {
  o.onStatus?.("running");
  const step = o.agentStep ?? agentStep;
  let main = await step(dir, meta, {
    prompt,
    model: meta.model,
    session: o.continueSession ? "continue" : "new",
    signal: o.signal,
    onEvent: o.onEvent,
  });
  // A dropped model connection gets one automatic retry in the same pi session, so a long task
  // survives a busy API. Review steps below never retry.
  if (main.status === "failed" && isTransientModelError(main.error) && !o.signal.aborted) {
    o.onEvent({ type: "hive_note", text: "The model connection dropped; trying again in 60 s in the same session." });
    await abortableDelay(o.retryDelayMs ?? TRANSIENT_RETRY_DELAY_MS, o.signal);
    main = o.signal.aborted
      ? { status: "aborted", lastText: "" }
      : await step(dir, meta, {
          prompt: TRANSIENT_RETRY_PROMPT,
          model: meta.model,
          session: "continue",
          signal: o.signal,
          onEvent: o.onEvent,
        });
  }
  let status = main.status;
  let error = main.error;
  if (main.summary !== undefined) meta.summary = main.summary.slice(0, 60_000);

  // A "review and report" task makes no commits, and a review cycle on it would rebuild the
  // project for nothing. Find out with the export step (in a VM, as for the final export), then
  // skip the cycles when nothing was committed. A failed export leaves the reviews as they were.
  const cycles = meta.reviewCycles ?? 0;
  let commits: number | undefined;
  if (status === "done" && cycles > 0 && existsSync(join(dir, "work"))) {
    const pre = await exportPatches(dir, meta);
    commits = pre.ok ? pre.commits : undefined;
  }
  if (shouldReview({ status, cycles, commits })) {
    for (let i = 1; i <= cycles; i++) {
      o.onStatus?.("reviewing", { cycle: i, of: cycles });
      const review = await step(dir, meta, {
        prompt: REVIEW_PROMPT(prompt, meta.base),
        model: meta.reviewModel || meta.model,
        session: "none",
        signal: o.signal,
        onEvent: o.onEvent,
      });
      if (review.status !== "done") {
        status = review.status;
        error = review.error;
        break;
      }
      if (isLgtm(review.lastText)) break;
    }
  } else if (status === "done" && cycles > 0 && commits === 0) {
    o.onEvent({ type: "hive_note", text: "No commits, so the review was skipped." });
  }

  // Export whatever the agent committed, whatever the outcome: a run that timed out, stalled,
  // failed or was stopped still keeps the work it committed. A follow-up exports the whole
  // history again, so out/ starts empty.
  if (existsSync(join(dir, "work"))) {
    const exp = await exportPatches(dir, meta);
    if (!exp.ok) {
      const note = `export failed (exit ${exp.code})`;
      if (status === "done") {
        status = "failed";
        error = note;
      } else {
        error = error === undefined ? note : `${error}; ${note}`;
      }
    } else {
      meta.commits = exp.commits;
    }
  }

  meta.status = status;
  if (error !== undefined) meta.error = error;
  else delete meta.error;
  meta.finishedAt = Date.now();
  writeMeta(dir, meta);
  return { dir, meta };
}
