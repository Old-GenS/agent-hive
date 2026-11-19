/**
 * CLI runs. A run owns a directory:
 *
 *   <runsDir>/<repo>-<timestamp>/work      the agent's copy, mounted at /work
 *   <runsDir>/<repo>-<timestamp>/io        prompt.md, system.md, events.jsonl, stderr.log (/io)
 *   <runsDir>/<repo>-<timestamp>/session   pi's session dir (/session)
 *   <runsDir>/<repo>-<timestamp>/out       patches exported by the sandbox (/out)
 *
 * The VM writes its events to io/events.jsonl, never to stdout; the host follows that file.
 * The host never runs git inside work/ after prepareLocal returns.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config, PROVIDERS, providerKey, resolveProvider } from "./config.js";
import { runSandbox, type SandboxOptions } from "./sandbox.js";
import { git, gitIdentity, isDirty, prepareLocal, validateBranch } from "./git.js";
import { followJsonl } from "./follow.js";
import { addUsage, emptyUsage, type Usage } from "./render.js";

export type RunStatus = "running" | "done" | "failed" | "aborted";

export interface RunMeta {
  repo: string;
  base: string;
  provider: string;
  model: string;
  thinking: string;
  /** first 200 characters of the prompt */
  prompt: string;
  status: RunStatus;
  pid: number;
  commits: number;
  usage: Usage;
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

/** Status "running" and the process that started the VM is still alive. */
export function isLive(meta: RunMeta): boolean {
  if (meta.status !== "running") return false;
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
  mkdirSync(join(dir, "io"), { recursive: true });
  mkdirSync(join(dir, "session"), { recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });
  return dir;
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

/** Absolute paths of out/*.patch, sorted. */
export function patchFiles(dir: string): string[] {
  const out = join(dir, "out");
  if (!existsSync(out)) return [];
  return readdirSync(out)
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => join(out, f));
}

/** Patch text, or `git apply --stat` output; "" when the run produced no commits. */
export async function diffRun(dir: string, stat: boolean): Promise<string> {
  const patches = patchFiles(dir);
  if (patches.length === 0) return "";
  if (stat) return await git(["apply", "--stat", ...patches], dir);
  return patches.map((p) => readFileSync(p, "utf8")).join("");
}

/**
 * Apply a finished run's patches to the user's repo: directly to the work tree when HEAD is
 * still the run's base, or as commits on a new branch from the base.
 */
export async function applyRun(dir: string, repo: string, branch?: string): Promise<string> {
  const meta = readMeta(dir);
  if (meta.status !== "done") throw new Error(`run is ${meta.status}; nothing to apply`);
  if (!(meta.commits > 0)) throw new Error("nothing to apply");
  if (realpathSync(repo) !== realpathSync(meta.repo)) throw new Error(`this run belongs to ${meta.repo}`);
  if (await isDirty(repo)) throw new Error("repo has uncommitted changes; commit or stash first");
  const patches = patchFiles(dir);

  if (!branch) {
    const head = await git(["rev-parse", "HEAD"], repo);
    if (head !== meta.base) throw new Error("repo HEAD moved since the run; use --branch");
    await git(["apply", ...patches], repo);
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
    await git(["am", "-q", "--keep-cr", ...patches], repo, 120_000);
  } catch (err) {
    await git(["am", "--abort"], repo).catch(() => {});
    throw err;
  }
  return `on branch ${branch}: ${meta.commits} commit(s)`;
}

export interface StartRunOptions {
  repo: string;
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: string;
  onEvent: (e: any) => void;
  signal: AbortSignal;
}

/**
 * Run pi on the current repo inside a libkrun microVM. Throws only on errors before the VM
 * starts; afterwards the outcome is recorded in meta.json and returned.
 */
export async function startRun(o: StartRunOptions): Promise<{ dir: string; meta: RunMeta }> {
  const provider = resolveProvider(o.provider);
  if (!provider || !PROVIDERS[provider]) {
    throw new Error(`Unknown or missing provider. Supported: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  const key = providerKey(provider);
  if (!key) throw new Error(`No API key configured for provider "${provider}"`);
  const model = o.model || config.defaultModel || PROVIDERS[provider].defaultModel;
  if (!model) throw new Error(`model is required for provider "${provider}" (or set DEFAULT_MODEL)`);
  const thinking = o.thinking || config.defaultThinking;
  if (!THINKING.includes(thinking)) throw new Error(`thinkingLevel must be one of ${THINKING.join(", ")}`);

  const dir = makeRunDir(o.repo);
  const base = await prepareLocal(o.repo, join(dir, "work"));
  writeFileSync(join(dir, "io", "prompt.md"), o.prompt);
  writeFileSync(join(dir, "io", "system.md"), config.systemPrompt);

  const meta: RunMeta = {
    repo: o.repo,
    base,
    provider,
    model,
    thinking,
    prompt: o.prompt.slice(0, 200),
    status: "running",
    pid: process.pid,
    commits: 0,
    usage: emptyUsage(),
    createdAt: Date.now(),
  };
  writeMeta(dir, meta);

  const mounts: SandboxOptions["mounts"] = [
    { host: join(dir, "work"), container: "/work" },
    { host: join(dir, "io"), container: "/io" },
    { host: join(dir, "session"), container: "/session" },
  ];
  // The npm cache is shared with the server's sandboxes (and survives them); export runs skip it.
  if (config.sandbox.npmCache) {
    mkdirSync(config.sandbox.npmCache, { recursive: true });
    mounts.push({ host: config.sandbox.npmCache, container: "/root/.npm", shared: true });
  }

  const command = [
    "bash", "-c", 'exec hive-agent "$@" > /io/events.jsonl 2> /io/stderr.log', "hive-agent",
    "-p",
    "--provider", provider,
    "--model", model,
    "--thinking", thinking,
    "--session-dir", "/session",
    "--append-system-prompt", "/io/system.md",
    "@/io/prompt.md",
    "Do the task described in the attached file prompt.md.",
  ];

  const handle = runSandbox({
    name: "hive-" + basename(dir),
    mounts,
    env: { [PROVIDERS[provider].sandboxEnv]: key, ...gitIdentity() },
    command,
  });

  const follower = followJsonl(join(dir, "io", "events.jsonl"), (e) => {
    addUsage(meta.usage, e);
    o.onEvent(e);
  });
  const onAbort = () => {
    void handle.stop();
  };
  if (o.signal.aborted) onAbort();
  else o.signal.addEventListener("abort", onAbort, { once: true });

  const result = await handle.done;
  follower.stop();
  o.signal.removeEventListener("abort", onAbort);

  let status: RunStatus = "done";
  let error: string | undefined;
  if (o.signal.aborted) {
    status = "aborted";
  } else if (result.timedOut) {
    status = "failed";
    error = `timed out after ${config.sandbox.timeoutMin} minutes`;
  } else if (result.code !== 0) {
    status = "failed";
    let stderrText = "";
    try {
      stderrText = readFileSync(join(dir, "io", "stderr.log"), "utf8");
    } catch {
      // no stderr.log: fall back to what the launcher kept
    }
    if (!stderrText) stderrText = result.stderr;
    error = `agent exited ${result.code}: ` + stderrText.slice(-2000);
  }

  if (result.code === 0 && !o.signal.aborted) {
    const exp = runSandbox({
      name: "hive-" + basename(dir) + "-export",
      mounts: [
        { host: join(dir, "work"), container: "/work" },
        { host: join(dir, "out"), container: "/out" },
      ],
      env: gitIdentity(),
      command: ["hive-export", base],
    });
    const r = await exp.done;
    if (r.code !== 0) {
      status = "failed";
      error = `export failed (exit ${r.code})`;
    } else {
      meta.commits = patchFiles(dir).length;
      status = "done";
    }
  }

  meta.status = status;
  if (error !== undefined) meta.error = error;
  meta.finishedAt = Date.now();
  writeMeta(dir, meta);
  return { dir, meta };
}
