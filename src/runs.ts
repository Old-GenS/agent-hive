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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config, effectiveModel, PROVIDERS, providerKey, resolveProvider } from "./config.js";
import { runSandbox, type SandboxOptions } from "./sandbox.js";
import {
  applyAndPush,
  git,
  githubSlug,
  gitIdentity,
  isDirty,
  prepareLocal,
  prepareRepo,
  validateBranch,
} from "./git.js";
import { followJsonl } from "./follow.js";
import { addUsage, emptyUsage, type Usage } from "./render.js";

const execFileAsync = promisify(execFile);

export type RunStatus = "running" | "done" | "failed" | "aborted";

export interface RunMeta {
  repo: string;
  /** "local" when the run cloned the user's checkout; "remote" when it cloned a URL. */
  source: "local" | "remote";
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
  /** text of the agent's latest assistant message, written when the run ends */
  summary?: string;
  /** where `hive push` put the run's commits */
  pushed?: { branch: string; url: string; at: number };
  prUrl?: string;
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
  if (meta.source === "remote") throw new Error("this run is from " + meta.repo + "; use hive push");
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
 */
export async function pushRun(
  dir: string,
  o: { branch?: string; remote?: string; requireGithub?: boolean } = {},
): Promise<{ branch: string; url: string; commits: number }> {
  const meta = readMeta(dir);
  if (meta.status !== "done") throw new Error(`run is ${meta.status}; nothing to push`);
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
  let title = first ? patchSubject(readFileSync(first, "utf8")) : "";
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
  /** Local repo to clone; mutually exclusive with `remote`. */
  repo?: string;
  /** Remote repo to clone; mutually exclusive with `repo`. */
  remote?: { url: string; name: string; ref?: string };
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
  if ((o.repo !== undefined) === (o.remote !== undefined)) throw new Error("startRun needs repo or remote");
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

  const dir = makeRunDir(o.remote ? o.remote.name : (o.repo as string));
  const base = o.remote
    ? await prepareRepo(dir, o.remote.url, o.remote.ref)
    : await prepareLocal(o.repo as string, join(dir, "work"));
  writeFileSync(join(dir, "io", "prompt.md"), o.prompt);
  writeFileSync(join(dir, "io", "system.md"), config.systemPrompt);

  const meta: RunMeta = {
    repo: o.remote ? o.remote.url : (o.repo as string),
    source: o.remote ? "remote" : "local",
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
    { host: join(dir, "session"), container: "/session" },
  ];
  // The npm cache is shared with the server's sandboxes (and survives them); export runs skip it.
  if (config.sandbox.npmCache) {
    mkdirSync(config.sandbox.npmCache, { recursive: true });
    mounts.push({ host: config.sandbox.npmCache, container: "/root/.npm", shared: true });
  }

  const command = [
    "hive-agent",
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
    ioDir: join(dir, "io"),
  });

  let summary: string | undefined;
  const follower = followJsonl(join(dir, "io", "events.jsonl"), (e) => {
    addUsage(meta.usage, e);
    if (e?.type === "message_end" && e.message?.role === "assistant") {
      const text = (Array.isArray(e.message.content) ? e.message.content : [])
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
      if (text) summary = text;
    }
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
      // Its own folder, so the export never touches the agent's event log (hive log reads it).
      ioDir: join(dir, "io-export"),
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
  if (summary !== undefined) meta.summary = summary.slice(0, 60_000);
  meta.finishedAt = Date.now();
  writeMeta(dir, meta);
  return { dir, meta };
}
