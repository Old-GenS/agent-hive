/**
 * Tasks (called "sessions" in the HTTP API for compatibility). A task owns a directory:
 *
 *   <workspace>/<id>/origin   pristine clone, host only (holds the push remote)
 *   <workspace>/<id>/work     the sandbox's copy, mounted at /work
 *   <workspace>/<id>/session  pi's session files, mounted at /session (follow-ups continue it)
 *   <workspace>/<id>/out      patches exported by the sandbox for the host to apply
 *
 * Each prompt runs pi in a fresh sandbox; optional review cycles run more sandboxes on the same
 * copy; then the changes are exported as patches, applied to the pristine clone and pushed to a
 * new branch. The directory is deleted once the task has been idle for SESSION_IDLE_TIMEOUT_MS.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config, effectiveModel, PROVIDERS, providerKey, resolveProvider } from "./config.js";
import { runSandbox, runtimeInfo, type SandboxHandle, type SandboxOptions } from "./sandbox.js";
import {
  applyAndPush,
  changeSummary,
  openIssue,
  issueBody,
  openPullRequest,
  prBody,
  githubSlug,
  type ChangeSummary,
  createGithubRepo,
  git,
  normalizeRepo,
  prepareNewRepo,
  prepareRepo,
  validateBranch,
  validateRepoName,
} from "./git.js";

export type TaskStatus = "queued" | "cloning" | "running" | "reviewing" | "pushing" | "idle" | "failed" | "aborted";
const BUSY: TaskStatus[] = ["queued", "cloning", "running", "reviewing", "pushing"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface TaskOptions {
  prompt: string;
  repo?: string;
  branch?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  reviewCycles?: number;
  reviewModel?: string;
  /** start from an empty repository and create the GitHub repo when the run has commits */
  newRepo?: { name: string; private?: boolean };
  /** one-shot: no session kept, task removed once its result is read */
  ephemeral?: boolean;
}

export interface ChatMessage {
  role: string;
  content: string;
  timestamp?: number;
}

const MAX_REPLAY_EVENTS = 5000;

export class Task extends EventEmitter {
  readonly id = randomUUID();
  readonly dir: string;
  readonly createdAt = Date.now();
  lastActivity = Date.now();
  status: TaskStatus = "queued";
  error?: string;
  repoUrl?: string;
  branch?: string;
  newRepoName?: string;
  newRepoPrivate = true;
  createdRepo?: string;
  baseSha?: string;
  resultBranch?: string;
  commitsPushed = 0;
  /** what the last push changed: commits and files */
  changes?: ChangeSummary;
  /** the pull request opened from resultBranch, if any */
  prUrl?: string;
  /** the issue a no-change review was posted to, if any */
  issueUrl?: string;
  /** token and cost totals over every agent run of this task */
  usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  messages: ChatMessage[] = [];
  /** events of the current prompt, replayed to WebSocket clients that connect late */
  replay: any[] = [];
  lastAssistantText = "";
  runs = 0;
  prepared = false;
  sessionStarted = false;
  private sandbox?: SandboxHandle;
  private abortRequested = false;

  constructor(
    readonly provider: string,
    readonly model: string,
    readonly thinkingLevel: string,
    readonly opts: TaskOptions,
  ) {
    super();
    this.setMaxListeners(50);
    this.dir = join(config.workspace, this.id);
  }

  get busy() {
    return BUSY.includes(this.status);
  }

  emitEvent(event: any) {
    this.lastActivity = Date.now();
    if (this.replay.length < MAX_REPLAY_EVENTS || event.type?.startsWith("hive_")) this.replay.push(event);
    this.emit("event", event);
  }

  setStatus(status: TaskStatus, extra: Record<string, unknown> = {}) {
    this.status = status;
    this.emitEvent({ type: "hive_status", status, ...extra });
  }

  resetAbort() {
    this.abortRequested = false;
  }

  async abort() {
    this.abortRequested = true;
    await this.sandbox?.stop();
  }

  toJSON() {
    return {
      sessionId: this.id,
      title: taskTitle(this.opts.prompt),
      status: this.status,
      isStreaming: this.busy,
      repo: this.repoUrl,
      branch: this.branch,
      newRepo: this.newRepoName,
      createdRepo: this.createdRepo,
      resultBranch: this.resultBranch,
      commitsPushed: this.commitsPushed,
      changes: this.changes,
      prUrl: this.prUrl,
      issueUrl: this.issueUrl,
      repoSlug: this.repoUrl ? githubSlug(this.repoUrl) : undefined,
      usage: this.usage,
      provider: this.provider,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      messageCount: this.messages.length,
      error: this.error,
      isolation: runtimeInfo.isolation,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    };
  }

  /** Run pi once in a fresh sandbox. Returns the final assistant text. */
  async runAgent(prompt: string, o: { model: string; continueSession: boolean; keepSession: boolean }): Promise<string> {
    if (this.abortRequested) throw new AbortError();
    const pi = ["--provider", this.provider, "--model", o.model, "--thinking", this.thinkingLevel];
    if (o.keepSession) {
      pi.push("--session-dir", "/session");
      if (o.continueSession) pi.push("--continue");
      this.sessionStarted = true;
    } else {
      pi.push("--no-session");
    }
    pi.push("--append-system-prompt", this.opts.systemPrompt || config.systemPrompt, "--", prompt);

    let lastText = "";
    let lastError = "";
    const key = providerKey(this.provider)!;
    const mounts: SandboxOptions["mounts"] = [
      { host: join(this.dir, "work"), container: "/work" },
      { host: join(this.dir, "session"), container: "/session" },
    ];
    // The npm cache is shared by every task (and survives sandboxes); export runs don't need it.
    if (config.sandbox.npmCache) {
      mkdirSync(config.sandbox.npmCache, { recursive: true });
      mounts.push({ host: config.sandbox.npmCache, container: "/root/.npm", shared: true });
    }
    this.sandbox = runSandbox({
      name: `hive-${this.id.slice(0, 8)}-${++this.runs}`,
      mounts,
      env: { [PROVIDERS[this.provider].sandboxEnv]: key, ...gitIdentity() },
      command: ["hive-agent", ...pi],
      ioDir: join(this.dir, "io"),
      onEvent: (event) => {
        // Bulky and only useful to a live tool view; the final result arrives in tool_execution_end.
        if (event.type === "tool_execution_update") return;
        if (event.type === "message_end" && event.message) {
          const m = event.message;
          const text = messageText(m);
          if (m.role === "assistant") {
            const u = m.usage ?? {};
            this.usage.input += u.input ?? 0;
            this.usage.output += u.output ?? 0;
            this.usage.cacheRead += u.cacheRead ?? 0;
            this.usage.cacheWrite += u.cacheWrite ?? 0;
            this.usage.cost += u.cost?.total ?? 0;
            if (text) lastText = text;
            if (m.stopReason === "error" || m.errorMessage) lastError = m.errorMessage || "model error";
          }
          if ((m.role === "user" || m.role === "assistant") && text) {
            this.messages.push({ role: m.role, content: text, timestamp: m.timestamp });
          }
        }
        this.emitEvent(event);
      },
    });
    const result = await this.sandbox.done;
    this.sandbox = undefined;
    if (this.abortRequested) throw new AbortError();
    if (result.timedOut) throw new Error(`Sandbox timed out after ${config.sandbox.timeoutMin} minutes`);
    if (result.code !== 0) throw new Error(`Sandbox exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-2000)}`);
    if (lastError && !lastText) throw new Error(lastError);
    return lastText;
  }

  /** Export the sandbox's commits as patches (inside a sandbox) and push them from the host. */
  async exportAndPush() {
    const out = join(this.dir, "out");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    this.changes = undefined;
    const exp = runSandbox({
      name: `hive-${this.id.slice(0, 8)}-export-${this.runs}`,
      mounts: [
        { host: join(this.dir, "work"), container: "/work" },
        { host: out, container: "/out" },
      ],
      env: gitIdentity(),
      command: ["hive-export", this.baseSha!],
      ioDir: join(this.dir, "io"),
    });
    const r = await exp.done;
    if (r.code !== 0) throw new Error(`Exporting changes failed: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
    if (this.newRepoName) {
      const patches = readdirSync(out).filter((f) => f.endsWith(".patch")).length;
      if (patches === 0) {
        this.commitsPushed = 0;
        return;
      }
      if (!this.createdRepo) {
        this.createdRepo = await createGithubRepo(this.newRepoName, this.newRepoPrivate);
        this.repoUrl = normalizeRepo(this.createdRepo).url;
        await git(["remote", "add", "origin", this.repoUrl], join(this.dir, "origin"));
      }
      // The repo was created by this task, and a follow-up rewrites main with the full history.
      this.commitsPushed = await applyAndPush(this.dir, this.baseSha!, "main");
      this.resultBranch = "main";
      this.changes = await changeSummary(this.dir, this.baseSha!);
      return;
    }
    const branch = `${config.git.branchPrefix}${this.id.slice(0, 8)}`;
    this.commitsPushed = await applyAndPush(this.dir, this.baseSha!, branch);
    if (this.commitsPushed > 0) {
      this.resultBranch = branch;
      this.changes = await changeSummary(this.dir, this.baseSha!);
    }
  }
}

/**
 * Open a pull request from a finished run's branch, with the agent's last message and the
 * change list as its description. Opening it again returns the same PR.
 */
export async function openTaskIssue(task: Task): Promise<string> {
  if (task.issueUrl) return task.issueUrl;
  if (task.busy) throw new Error("The run is still going");
  if (task.newRepoName || task.commitsPushed > 0) throw new Error("This run changed files; open a pull request instead");
  const slug = task.repoUrl ? githubSlug(task.repoUrl) : undefined;
  if (!slug) throw new Error("Issues need a github.com repository");
  if (!task.lastAssistantText.trim()) throw new Error("The agent left no write-up to post");
  const firstLine = (task.opts.prompt.split("\n").find((l) => l.trim()) ?? "").trim();
  const title = `hive review: ${firstLine.length > 70 ? firstLine.slice(0, 69) + "…" : firstLine || "findings"}`;
  task.issueUrl = await openIssue({
    slug,
    title,
    body: issueBody(task.lastAssistantText, { model: task.model, branch: task.branch, baseSha: task.baseSha }),
  });
  return task.issueUrl;
}

export async function openTaskPr(task: Task): Promise<string> {
  if (task.prUrl) return task.prUrl;
  if (task.busy) throw new Error("The run is still going");
  if (!task.resultBranch || task.createdRepo) throw new Error("This run has no branch to open a pull request from");
  const slug = task.repoUrl ? githubSlug(task.repoUrl) : undefined;
  if (!slug) throw new Error("Pull requests need a github.com repository");
  const firstLine = (task.opts.prompt.split("\n").find((l) => l.trim()) ?? "").trim();
  const title = `hive: ${firstLine.length > 70 ? firstLine.slice(0, 69) + "…" : firstLine || task.resultBranch}`;
  task.prUrl = await openPullRequest({
    slug,
    branch: task.resultBranch,
    title,
    body: prBody(task.lastAssistantText, task.changes, task.model),
  });
  return task.prUrl;
}

/** Commits made in the sandbox use the configured identity (env beats git config). */
function gitIdentity(): Record<string, string> {
  const { authorName, authorEmail } = config.git;
  return {
    GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail,
  };
}

class AbortError extends Error {
  constructor() {
    super("aborted");
  }
}

/** A one-line title for the run list: the prompt's first non-empty line, at most 120 chars. */
function taskTitle(prompt: string): string {
  const line = prompt.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed;
}

/** Plain text of a pi message: user content is a string or blocks; assistant content is blocks. */
export function messageText(m: any): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

// ── concurrency: at most maxConcurrent pipelines at once, a short queue behind them ──

let running = 0;
const waiters: (() => void)[] = [];

function acquire(): Promise<void> {
  if (running < config.maxConcurrent) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(() => { running++; resolve(); }));
}

function release() {
  running--;
  waiters.shift()?.();
}

export function capacity() {
  return { running, queued: waiters.length, max: config.maxConcurrent };
}

// ── registry ──

const tasks = new Map<string, Task>();

export function getTask(id: string) {
  return tasks.get(id);
}

/** Every non-ephemeral task, newest first. */
export function listTasks(): ReturnType<Task["toJSON"]>[] {
  return [...tasks.values()]
    .filter((task) => !task.opts.ephemeral)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((task) => task.toJSON());
}

export function taskCount() {
  return tasks.size;
}

export function destroyTask(id: string) {
  const task = tasks.get(id);
  if (!task) return;
  tasks.delete(id);
  void task.abort().finally(() => rmSync(task.dir, { recursive: true, force: true }));
}

setInterval(() => {
  const cutoff = Date.now() - config.idleTimeoutMs;
  for (const task of tasks.values()) {
    if (!task.busy && task.lastActivity < cutoff) destroyTask(task.id);
  }
}, 60_000).unref();

/** Validate options and create a task. Throws a user-facing Error on bad input. */
export function createTask(opts: TaskOptions): Task {
  if (waiters.length >= config.maxQueued) throw new BusyError();
  const provider = resolveProvider(opts.provider);
  if (!provider || !PROVIDERS[provider]) {
    throw new Error(`Unknown or missing provider. Supported: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  if (!providerKey(provider)) throw new Error(`No API key configured for provider "${provider}"`);
  const model = opts.model || effectiveModel(provider);
  if (!model) throw new Error(`model is required for provider "${provider}" (or set DEFAULT_MODEL)`);
  const thinking = opts.thinkingLevel || config.defaultThinking;
  if (!THINKING.includes(thinking)) throw new Error(`thinkingLevel must be one of ${THINKING.join(", ")}`);
  const cycles = opts.reviewCycles ?? 0;
  if (!Number.isInteger(cycles) || cycles < 0 || cycles > 5) throw new Error("reviewCycles must be 0-5");

  if (opts.repo && opts.newRepo) throw new Error("Use repo or newRepo, not both");
  const task = new Task(provider, model, thinking, opts);
  if (opts.repo) task.repoUrl = normalizeRepo(opts.repo).url;
  if (opts.newRepo) {
    task.newRepoName = validateRepoName(opts.newRepo.name);
    task.newRepoPrivate = opts.newRepo.private !== false;
  }
  if (opts.branch) task.branch = validateBranch(opts.branch);
  mkdirSync(join(task.dir, "session"), { recursive: true });
  tasks.set(task.id, task);
  return task;
}

export class BusyError extends Error {
  constructor() {
    super("Server is busy; try again shortly");
  }
}

const REVIEW_PROMPT = (task: string, base: string) => `You are reviewing changes another agent just made in this repository.

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

/**
 * Run one prompt through the pipeline. The first prompt clones the repo; later ones continue
 * the same pi session on the same copy and re-push the branch.
 */
export async function runPrompt(task: Task, prompt: string): Promise<void> {
  task.resetAbort();
  task.replay = [];
  task.error = undefined;
  task.setStatus("queued", capacity());
  await acquire();
  try {
    if (!task.prepared) {
      rmSync(join(task.dir, "origin"), { recursive: true, force: true });
      rmSync(join(task.dir, "work"), { recursive: true, force: true });
      if (task.newRepoName) {
        task.setStatus("cloning", { newProject: true });
        task.baseSha = await prepareNewRepo(task.dir);
      } else if (task.repoUrl) {
        task.setStatus("cloning");
        task.baseSha = await prepareRepo(task.dir, task.repoUrl, task.branch);
      } else {
        mkdirSync(join(task.dir, "work"), { recursive: true });
      }
      task.prepared = true;
    }

    task.setStatus("running");
    const intro = task.newRepoName
      ? "/work is an empty git repository for a new project. Create the project there and commit your work with clear messages. You cannot push; when you finish, the server creates the GitHub repository " +
        task.newRepoName +
        " and pushes your commits to it.\n\n"
      : task.repoUrl
        ? "The repository is checked out at /work. Make the changes there and commit them with clear messages. You cannot push; the server pushes your commits to a new branch when you finish.\n\n"
        : "";
    task.lastAssistantText = await task.runAgent(intro + prompt, {
      model: task.model,
      continueSession: task.sessionStarted,
      keepSession: !task.opts.ephemeral,
    });

    if ((task.repoUrl || task.newRepoName) && task.baseSha) {
      const cycles = task.opts.reviewCycles ?? 0;
      for (let i = 1; i <= cycles; i++) {
        task.setStatus("reviewing", { cycle: i, of: cycles });
        const review = await task.runAgent(REVIEW_PROMPT(prompt, task.baseSha), {
          model: task.opts.reviewModel || task.model,
          continueSession: false,
          keepSession: false,
        });
        if (/^\s*LGTM\b/i.test(review)) break;
      }
      task.setStatus("pushing");
      await task.exportAndPush();
    }
    task.setStatus("idle");
    task.emitEvent({
      type: "hive_done",
      status: "idle",
      resultBranch: task.resultBranch,
      commitsPushed: task.commitsPushed,
      createdRepo: task.createdRepo,
      changes: task.changes,
      repoSlug: task.repoUrl ? githubSlug(task.repoUrl) : undefined,
      usage: task.usage,
    });
  } catch (err) {
    const aborted = err instanceof AbortError;
    task.error = aborted ? undefined : (err as Error).message;
    task.setStatus(aborted ? "aborted" : "failed", task.error ? { error: task.error } : {});
    task.emitEvent({ type: "hive_done", status: task.status, error: task.error, resultBranch: task.resultBranch, createdRepo: task.createdRepo, usage: task.usage });
    if (!aborted) console.error(`task ${task.id} failed:`, task.error);
  } finally {
    release();
    task.lastActivity = Date.now();
  }
}
