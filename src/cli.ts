#!/usr/bin/env node
/**
 * `hive` — run pi on the current git repo in a throwaway libkrun microVM, then export/apply the
 * agent's commits. Text crosses the VM boundary only through files: io/ in, out/ (patches) back.
 *
 * Config/sandbox/runs/git are imported dynamically after the environment is prepared, so that
 * HIVE_DOTENV_PATH and HIVE_RUNTIME are in place before ./config.ts reads them.
 */
import { parseArgs } from "node:util";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { basename, join } from "node:path";
import { renderEvent, renderEventStyled, addUsage, emptyUsage } from "./render.js";
import { sourceDescription } from "./source-version.js";
import type { UninstallPlan } from "./uninstall.js";
import {
  StatusLine,
  ask,
  bold,
  colorEnabled,
  cyan,
  dim,
  formatCost,
  formatDuration,
  green,
  plainText,
  red,
  select,
  shouldOpenBrowser,
  symbols,
  table,
  yellow,
} from "./tui.js";

const USAGE = `hive run [-m model] [-p provider] [-t thinking] [--review <n>] [--review-model <model>] [--offline] [--instructions <file> [--replace-instructions]] [--json] [--repo <owner/name|url> [--ref <branch>]] "<prompt>"
hive run [-m model] [-p provider] [-t thinking] [--review <n>] [--review-model <model>] [--offline] [--instructions <file> [--replace-instructions]] [--json] [--repo <owner/name|url> [--ref <branch>]] -f <prompt-file>
hive new <name> [--public] [-m model] [-p provider] [-t thinking] [--review <n>] [--review-model <model>] [--offline] [--instructions <file> [--replace-instructions]] "<prompt>"
hive new <name> [--public] [-m model] [-p provider] [-t thinking] [--review <n>] [--review-model <model>] [--offline] [--instructions <file> [--replace-instructions]] -f <prompt-file>
hive continue [run] ["<prompt>"]
hive log [run] [--json]
hive diff [run] [--stat]
hive apply [run] [--branch <name>]
hive export [run] [--zip | --bundle | --report] [-o <path>] [--force]
hive push [run] [--branch <name>] [--remote <name>] [--pr [--base <branch>]] [--yes]
hive list
hive clean <run> | --all
hive keep [--off] <run>
hive keys [list]
hive keys add <provider> [--no-test]
hive keys test [provider]
hive keys remove <provider>
hive keys default <provider>
hive login github
hive serve [--host <addr>] [--port <n>] [--open | --no-open]
hive service <install|status|restart|logs|uninstall> [--host <addr>] [--port <n>] [--dry-run]
hive uninstall [--yes] [--all] [--dry-run]
hive setup
hive doctor
hive update [--check | --rollback | --tag <tag>]
hive --version
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Text that may carry the agent's own bytes, for a terminal. Filtered only when a person is
 * watching: piped output is machine input (a patch, a script) and must stay byte-exact.
 */
function forTerminal(text: string, stream: { isTTY?: boolean } = process.stdout): string {
  return stream.isTTY ? plainText(text) : text;
}

function writeEvent(json: boolean, render: (e: any) => string | undefined, e: any): void {
  if (json) {
    process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }
  const line = render(e);
  if (line !== undefined) process.stdout.write(line + "\n");
}

/** The first line of an error, for the one-line summary. */
function firstLine(text: string | undefined): string {
  return String(text ?? "").split("\n")[0].trim();
}

/**
 * One line about the pre-push scan, for a run summary or `hive log`. Files come from the patch's
 * `diff --git` line, so they go through plainText() before a terminal sees them. No secret value
 * is ever printed: the scan stores masked details only.
 */
function scanSummary(meta: {
  outputScan?: { blocked: boolean; warned: boolean; findings: { level: string; kind: string; file: string }[] };
}): string | undefined {
  const scan = meta.outputScan;
  if (!scan || scan.findings.length === 0) return undefined;
  if (scan.blocked) return "hive: output scan: blocked — the changes contain one of your API keys";
  const warnings = scan.findings.filter((f) => f.level === "warn");
  if (warnings.length === 0) return undefined;
  const list = warnings.map((f) => `${f.kind} ${plainText(f.file)}`).join(", ");
  return `hive: output scan: ${warnings.length} warning${warnings.length === 1 ? "" : "s"} — ${list}`;
}

function printScanSummary(meta: Parameters<typeof scanSummary>[0]): void {
  const line = scanSummary(meta);
  if (line !== undefined) console.error(forTerminal(line, process.stderr));
}

/** `2h ago`, or `running 3m` while a run is live. */
function runAge(meta: { status: string; createdAt: number; finishedAt?: number }, now = Date.now()): string {
  if (meta.status === "running" || meta.status === "queued") return `running ${formatDuration(now - meta.createdAt)}`;
  const ms = now - (meta.finishedAt ?? meta.createdAt);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** The coloured STATUS cell of `hive list`; the running dot only on a terminal. */
function runStatusCell(status: string, tty: boolean): string {
  const dot = (text: string): string => (tty ? `${symbols.running} ${text}` : text);
  switch (status) {
    case "done":
      return green(status, true);
    case "failed":
      return red(status, true);
    case "aborted":
      return yellow(status, true);
    case "running":
    case "queued":
      return cyan(dot(status), true);
    default:
      return status;
  }
}

/**
 * The live view of one run on stderr: a status line while the steps run, a line per finished
 * step, and the final summary. In plain mode (`rich` false) only `print` writes, so every line is
 * exactly what it was before.
 */
class RunProgress {
  readonly rich: boolean;
  readonly outColor: boolean;
  private readonly json: boolean;
  private readonly out: NodeJS.WriteStream;
  private readonly err: NodeJS.WriteStream;
  private readonly status: StatusLine;
  private readonly startedAt = Date.now();
  private readonly usage = emptyUsage();
  private tools = 0;
  private step = "Starting";
  private lastStatus: string | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private repoLabel = "the repo";

  constructor(o: { json: boolean; out?: NodeJS.WriteStream; err?: NodeJS.WriteStream }) {
    this.json = o.json;
    this.out = o.out ?? process.stdout;
    this.err = o.err ?? process.stderr;
    this.rich = !o.json && colorEnabled(this.err);
    this.outColor = !o.json && colorEnabled(this.out);
    this.status = new StatusLine(this.err);
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  private statusText(): string {
    const tools = `${this.tools} tool${this.tools === 1 ? "" : "s"}`;
    return `${this.step} · ${formatDuration(this.elapsedMs())} · ${formatCost(this.usage.cost)} · ${tools}`;
  }

  private refresh(): void {
    if (this.rich) this.status.update(this.statusText());
  }

  /** Start the status line. The announce poll prints `hive: run <name>` separately. */
  runStarted(o: { label?: string } = {}): void {
    if (o.label !== undefined) this.repoLabel = o.label;
    if (!this.rich) return;
    this.status.start(this.statusText());
    this.ticker = setInterval(() => this.refresh(), 250);
    this.ticker.unref?.();
  }

  /** Enter a run step; the previous step's finished line is printed when it ends. */
  setStep(status: string, extra?: Record<string, unknown>): void {
    const previous = this.lastStatus;
    this.lastStatus = status;
    if (status === "cloning") this.step = "Cloning";
    else if (status === "queued") this.step = "Waiting for a slot";
    else if (status === "exporting") this.step = "Exporting";
    else if (status === "running") {
      if (this.rich && previous === "cloning") this.status.print(green(`${symbols.done} Cloned ${this.repoLabel}`, true));
      else if (this.rich && previous === "queued") this.status.print(green(`${symbols.done} Got a slot`, true));
      this.step = "Agent working";
    } else if (status === "reviewing") {
      if (this.rich && previous !== "reviewing") this.status.print(green(`${symbols.done} Agent finished`, true));
      const cycle = Number(extra?.cycle ?? 0);
      const of = Number(extra?.of ?? 0);
      this.step = `Reviewing (${cycle}/${of})`;
    } else this.step = status;
    this.refresh();
  }

  /** Print one pi event: raw JSON with --json, Markdown with colour, plain text otherwise. */
  event(e: any): void {
    if (e?.type === "tool_execution_start") this.tools++;
    addUsage(this.usage, e);
    if (this.json) {
      this.out.write(JSON.stringify(e) + "\n");
      return;
    }
    const width = (this.out as { columns?: number }).columns ?? 80;
    const line = this.outColor
      ? renderEventStyled(e, { enabled: true, width })
      : renderEvent(e);
    if (this.rich) {
      // Through the status line, so agent text never lands on it; empty lines are dropped.
      if (line) this.status.printOn(this.out, line);
    } else if (line !== undefined) this.out.write(line + "\n");
    this.refresh();
  }

  /** A permanent stderr line: through the status line when it is live, straight out otherwise. */
  print(line: string): void {
    if (this.rich) this.status.print(line);
    else this.err.write(line + "\n");
  }

  /** One `✓ Agent finished` line for the step that was in progress when the run ended. */
  stepResult(status: string): void {
    if (!this.rich) return;
    const symbol =
      status === "done"
        ? green(symbols.done, true)
        : status === "aborted"
          ? yellow(symbols.stopped, true)
          : red(symbols.failed, true);
    const what = status === "done" ? "finished" : status === "aborted" ? "stopped" : "failed";
    if (this.lastStatus === "running") this.status.print(`${symbol} Agent ${what}`);
    else if (this.lastStatus === "reviewing") this.status.print(`${symbol} Review ${what}`);
  }

  /** Clear the status line and ticker (also on a thrown error); safe to call twice. */
  cleanup(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    this.status.stop();
  }

  /** The final one-line summary, its dimmed hints, then stop. */
  finish(o: { kind: "done" | "failed" | "stopped"; body: string; hints?: string[]; extra?: string[] }): void {
    this.cleanup();
    if (!this.rich) return;
    const symbol =
      o.kind === "done"
        ? green(symbols.done, true)
        : o.kind === "failed"
          ? red(symbols.failed, true)
          : yellow(symbols.stopped, true);
    const body = o.kind === "done" ? green(o.body, true) : o.kind === "failed" ? red(o.body, true) : yellow(o.body, true);
    this.err.write(`${symbol} ${body}\n`);
    for (const line of o.extra ?? []) this.err.write(dim(line, true) + "\n");
    for (const line of o.hints ?? []) this.err.write(dim(line, true) + "\n");
  }
}

/**
 * `--instructions <file>` for a run's own instructions, and `--replace-instructions` to use them
 * instead of the default. The file is read before anything starts so a bad path fails clearly.
 */
function instructionsOptions(values: {
  instructions?: string;
  "replace-instructions"?: boolean;
}): { instructions?: string; instructionsMode?: "add" | "replace" } {
  if (values["replace-instructions"] && values.instructions === undefined) {
    throw new Error("--replace-instructions needs --instructions <file>");
  }
  if (values.instructions === undefined) return {};
  let text: string;
  try {
    text = readFileSync(values.instructions, "utf8");
  } catch (err) {
    throw new Error(`cannot read instructions file "${values.instructions}": ${(err as Error).message}`);
  }
  return {
    instructions: text,
    instructionsMode: values["replace-instructions"] ? "replace" : "add",
  };
}

async function cmdRun(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m" },
      provider: { type: "string", short: "p" },
      thinking: { type: "string", short: "t" },
      json: { type: "boolean" },
      file: { type: "string", short: "f" },
      repo: { type: "string" },
      ref: { type: "string" },
      review: { type: "string" },
      "review-model": { type: "string" },
      offline: { type: "boolean" },
      instructions: { type: "string" },
      "replace-instructions": { type: "boolean" },
    },
  });
  const extra = instructionsOptions(values);
  const { normalizeCliRepo, repoTop, isDirty } = await import("./git.js");
  const { startRun, listRuns, recoverRuns, pruneRuns } = await import("./runs.js");
  const { libkrunAvailable, checkSandbox } = await import("./sandbox.js");
  const { bundleRoot, updateNotice } = await import("./release.js");
  const progress = new RunProgress({ json: !!values.json });

  // Stop VMs left by a crashed hive and drop finished runs past the retention limit.
  recoverRuns();
  pruneRuns();

  let prompt = values.file ? readFileSync(values.file, "utf8") : (positionals[0] ?? "");
  if (!prompt.trim() && values.file === undefined && process.stdin.isTTY === true) {
    prompt = await ask("What should the agent do?");
  }
  if (!prompt.trim()) throw new Error("a prompt is required");
  if (values.ref !== undefined && values.repo === undefined) throw new Error("--ref needs --repo");

  let repo: string | undefined;
  let remote: { url: string; name: string; ref?: string } | undefined;
  if (values.repo !== undefined) {
    remote = { ...normalizeCliRepo(values.repo), ref: values.ref };
  } else {
    repo = await repoTop(process.cwd());
  }
  const repoLabel = remote?.name ?? (repo === undefined ? "the repo" : basename(repo));

  if (!libkrunAvailable()) {
    console.error("hive: can't start a VM:");
    for (const problem of checkSandbox()) console.error(problem);
    console.error(
      sandboxRequirements(),
    );
    const rootfs = process.env.HIVE_ROOTFS;
    if (bundleRoot() && rootfs !== undefined && !existsSync(rootfs)) {
      console.error("hive: run hive setup to download the VM filesystem");
    }
    return 1;
  }

  const notice = await updateNotice();
  if (notice !== undefined) console.error(notice);

  if (repo !== undefined && (await isDirty(repo))) {
    console.error("hive: uncommitted changes are not included; the agent works on HEAD");
  }

  const abort = new AbortController();
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    progress.print("hive: stopping…");
    abort.abort();
  };
  process.on("SIGINT", onSigint);

  // startRun() reports the run only when it finishes, so watch the runs dir for the new one.
  const before = new Set(listRuns().map((r) => r.dir));
  const announce = setInterval(() => {
    const fresh = listRuns().find((r) => !before.has(r.dir));
    if (fresh) {
      progress.print(progress.rich ? dim(`hive: run ${fresh.name}`, true) : `hive: run ${fresh.name}`);
      clearInterval(announce);
    }
  }, 100);

  let run: Awaited<ReturnType<typeof startRun>>;
  try {
    run = await startRun({
      repo,
      remote,
      prompt,
      provider: values.provider,
      model: values.model,
      thinking: values.thinking,
      reviewCycles: values.review !== undefined ? Number(values.review) : undefined,
      reviewModel: values["review-model"],
      offline: values.offline === true,
      instructions: extra.instructions,
      instructionsMode: extra.instructionsMode,
      signal: abort.signal,
      onStart: () => progress.runStarted({ label: repoLabel }),
      onStatus: (status, extra) => progress.setStep(status, extra),
      onEvent: (e) => progress.event(e),
    });
  } finally {
    clearInterval(announce);
    progress.cleanup();
    process.removeListener("SIGINT", onSigint);
  }

  const dir = run.dir;
  const meta = run.meta;
  printScanSummary(meta);

  const name = basename(dir);
  const routing = meta.routing as any;
  if (Array.isArray(routing?.order) && routing.order.length > 0) {
    const line = `hive: providers, in order: ${routing.order.join(", ")}`;
    progress.print(progress.rich ? dim(line, true) : line);
  }
  progress.stepResult(meta.status);
  if (meta.status === "done") {
    const hints = [`hive diff ${name}`];
    if (meta.source !== "remote") hints.push(`hive apply ${name}`);
    hints.push(`hive push ${name}`);
    if (progress.rich) {
      progress.finish({
        kind: "done",
        body: `Done · ${meta.commits} commit${meta.commits === 1 ? "" : "s"} · ${formatDuration(progress.elapsedMs())} · ${formatCost(meta.usage.cost)}`,
        hints: meta.commits === 0 ? [] : hints,
        extra: meta.commits === 0 ? ["no changes"] : [],
      });
    } else {
      console.error(
        `hive: done, ${meta.commits} commit(s), $${meta.usage.cost.toFixed(4)}, ${meta.usage.input} in / ${meta.usage.output} out tokens`,
      );
      if (meta.commits === 0) {
        console.error("hive: no changes");
        return 0;
      }
      for (const hint of hints) console.error(hint);
    }
    return 0;
  }
  if (meta.status === "aborted") {
    if (progress.rich) progress.finish({ kind: "stopped", body: "Stopped" });
    else console.error("hive: aborted");
    return 130;
  }
  if (progress.rich) progress.finish({ kind: "failed", body: `Failed · ${firstLine(meta.error)}` });
  else console.error(`hive: failed: ${meta.error}`);
  return 1;
}

/**
 * `hive new <name> "<prompt>"`: start a new project from an empty repository. When the agent has
 * commits, `hive push <run>` creates the GitHub repository and pushes to main.
 */
async function cmdNew(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      public: { type: "boolean" },
      model: { type: "string", short: "m" },
      provider: { type: "string", short: "p" },
      thinking: { type: "string", short: "t" },
      file: { type: "string", short: "f" },
      review: { type: "string" },
      "review-model": { type: "string" },
      offline: { type: "boolean" },
      instructions: { type: "string" },
      "replace-instructions": { type: "boolean" },
    },
  });
  const extra = instructionsOptions(values);
  const projectName = positionals[0];
  if (!projectName) throw new Error("hive new needs a project name");
  let prompt = values.file ? readFileSync(values.file, "utf8") : (positionals[1] ?? "");
  if (!prompt.trim() && values.file === undefined && process.stdin.isTTY === true) {
    prompt = await ask("What should the agent do?");
  }
  if (!prompt.trim()) throw new Error("a prompt is required");

  const { startRun, listRuns, recoverRuns, pruneRuns } = await import("./runs.js");
  const { libkrunAvailable, checkSandbox } = await import("./sandbox.js");
  const progress = new RunProgress({ json: false });
  recoverRuns();
  pruneRuns();

  if (!libkrunAvailable()) {
    console.error("hive: can't start a VM:");
    for (const problem of checkSandbox()) console.error(problem);
    console.error(
      sandboxRequirements(),
    );
    return 1;
  }

  const abort = new AbortController();
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    progress.print("hive: stopping…");
    abort.abort();
  };
  process.on("SIGINT", onSigint);

  // startRun() reports the run only when it finishes, so watch the runs dir for the new one.
  const before = new Set(listRuns().map((r) => r.dir));
  const announce = setInterval(() => {
    const fresh = listRuns().find((r) => !before.has(r.dir));
    if (fresh) {
      progress.print(progress.rich ? dim(`hive: run ${fresh.name}`, true) : `hive: run ${fresh.name}`);
      clearInterval(announce);
    }
  }, 100);

  let run: Awaited<ReturnType<typeof startRun>>;
  try {
    run = await startRun({
      newRepo: { name: projectName, private: !values.public },
      prompt,
      provider: values.provider,
      model: values.model,
      thinking: values.thinking,
      reviewCycles: values.review !== undefined ? Number(values.review) : undefined,
      reviewModel: values["review-model"],
      offline: values.offline === true,
      instructions: extra.instructions,
      instructionsMode: extra.instructionsMode,
      signal: abort.signal,
      onStart: () => progress.runStarted({ label: projectName }),
      onStatus: (status, extra) => progress.setStep(status, extra),
      onEvent: (e) => progress.event(e),
    });
  } finally {
    clearInterval(announce);
    progress.cleanup();
    process.removeListener("SIGINT", onSigint);
  }

  const runName = basename(run.dir);
  const meta = run.meta;
  printScanSummary(meta);
  const routing = meta.routing as any;
  if (Array.isArray(routing?.order) && routing.order.length > 0) {
    const line = `hive: providers, in order: ${routing.order.join(", ")}`;
    progress.print(progress.rich ? dim(line, true) : line);
  }
  progress.stepResult(meta.status);
  if (meta.status === "done") {
    if (progress.rich) {
      progress.finish({
        kind: "done",
        body: `Done · ${meta.commits} commit${meta.commits === 1 ? "" : "s"} · ${formatDuration(progress.elapsedMs())} · ${formatCost(meta.usage.cost)}`,
        extra: [
          `new project ${projectName} (run ${runName})`,
          ...(meta.commits === 0 ? ["no changes"] : []),
        ],
        hints: meta.commits === 0 ? [] : [`hive push ${runName}`],
      });
    } else {
      console.error(
        `hive: done, ${meta.commits} commit(s), $${meta.usage.cost.toFixed(4)}, ${meta.usage.input} in / ${meta.usage.output} out tokens`,
      );
      console.error(`hive: new project ${projectName} (run ${runName})`);
      if (meta.commits === 0) {
        console.error("hive: no changes");
        return 0;
      }
      console.error(`hive push ${runName}`);
    }
    return 0;
  }
  if (meta.status === "aborted") {
    if (progress.rich) progress.finish({ kind: "stopped", body: "Stopped" });
    else console.error("hive: aborted");
    return 130;
  }
  if (progress.rich) progress.finish({ kind: "failed", body: `Failed · ${firstLine(meta.error)}` });
  else console.error(`hive: failed: ${meta.error}`);
  return 1;
}

/** The prompt `hive continue` sends when none is given. */
export const DEFAULT_CONTINUE_PROMPT = "Continue the task from where you left off; don't redo finished work.";

/**
 * `hive continue`'s positionals: two mean <run> <prompt>; one means a run name when it resolves,
 * otherwise the prompt for the newest run; none means the newest run with the default prompt.
 */
export function resolveContinueArgs(
  positionals: string[],
  isRun: (name: string) => boolean,
): { run: string | undefined; prompt: string } {
  if (positionals.length >= 2) return { run: positionals[0], prompt: positionals[1] };
  const only = positionals[0];
  if (only === undefined) return { run: undefined, prompt: DEFAULT_CONTINUE_PROMPT };
  if (isRun(only)) return { run: only, prompt: DEFAULT_CONTINUE_PROMPT };
  return { run: undefined, prompt: only };
}

async function cmdContinue(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean" } },
  });
  const { continueRun, recoverRuns, resolveRun } = await import("./runs.js");
  const { libkrunAvailable, checkSandbox } = await import("./sandbox.js");
  const progress = new RunProgress({ json: !!values.json });
  recoverRuns();

  const { run: runArg, prompt } = resolveContinueArgs(positionals, (name) => {
    try {
      resolveRun(name);
      return true;
    } catch {
      return false;
    }
  });
  if (!prompt.trim()) throw new Error("a prompt is required");

  if (!libkrunAvailable()) {
    console.error("hive: can't start a VM:");
    for (const problem of checkSandbox()) console.error(problem);
    console.error(
      sandboxRequirements(),
    );
    return 1;
  }

  const dir = resolveRun(runArg);
  const abort = new AbortController();
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    progress.print("hive: stopping…");
    abort.abort();
  };
  process.on("SIGINT", onSigint);

  progress.runStarted({ label: basename(dir) });
  let run: Awaited<ReturnType<typeof continueRun>>;
  try {
    run = await continueRun(dir, {
      prompt,
      signal: abort.signal,
      onStatus: (status, extra) => progress.setStep(status, extra),
      onEvent: (e) => progress.event(e),
    });
  } finally {
    progress.cleanup();
    process.removeListener("SIGINT", onSigint);
  }

  const name = basename(run.dir);
  const meta = run.meta;
  printScanSummary(meta);
  progress.stepResult(meta.status);
  if (meta.status === "done") {
    const hints = [`hive diff ${name}`, `hive push ${name}`];
    if (progress.rich) {
      progress.finish({
        kind: "done",
        body: `Done · ${meta.commits} commit${meta.commits === 1 ? "" : "s"} · ${formatDuration(progress.elapsedMs())} · ${formatCost(meta.usage.cost)}`,
        hints,
      });
    } else {
      console.error(
        `hive: done, ${meta.commits} commit(s), $${meta.usage.cost.toFixed(4)}, ${meta.usage.input} in / ${meta.usage.output} out tokens`,
      );
      for (const hint of hints) console.error(hint);
    }
    return 0;
  }
  if (meta.status === "aborted") {
    if (progress.rich) progress.finish({ kind: "stopped", body: "Stopped" });
    else console.error("hive: aborted");
    return 130;
  }
  if (progress.rich) progress.finish({ kind: "failed", body: `Failed · ${firstLine(meta.error)}` });
  else console.error(`hive: failed: ${meta.error}`);
  return 1;
}

async function cmdLog(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean" } },
  });
  const { resolveRun, readMeta, isLive } = await import("./runs.js");
  const { followJsonl } = await import("./follow.js");
  const { renderEvent } = await import("./render.js");

  const dir = resolveRun(positionals[0]);
  const follower = followJsonl(join(dir, "io", "events.jsonl"), (e) => writeEvent(!!values.json, renderEvent, e));
  if (!isLive(readMeta(dir))) {
    follower.poll();
    follower.stop();
    const meta = readMeta(dir);
    console.error(`hive: ${meta.status}`);
    printScanSummary(meta);
    return 0;
  }
  while (isLive(readMeta(dir))) await sleep(500);
  follower.stop();
  const meta = readMeta(dir);
  console.error(`hive: ${meta.status}`);
  printScanSummary(meta);
  return 0;
}

async function cmdDiff(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { stat: { type: "boolean" } },
  });
  const { resolveRun, diffRun } = await import("./runs.js");
  const text = await diffRun(resolveRun(positionals[0]), !!values.stat);
  if (!text) {
    console.error("hive: no changes");
    return 0;
  }
  const shown = forTerminal(text);
  process.stdout.write(shown.endsWith("\n") ? shown : shown + "\n");
  return 0;
}

async function cmdApply(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { branch: { type: "string" } },
  });
  const { repoTop } = await import("./git.js");
  const { applyRun, resolveRun } = await import("./runs.js");
  const result = await applyRun(resolveRun(positionals[0]), await repoTop(process.cwd()), values.branch);
  process.stdout.write(result + "\n");
  return 0;
}

async function cmdExport(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      zip: { type: "boolean" },
      bundle: { type: "boolean" },
      report: { type: "boolean" },
      output: { type: "string", short: "o" },
      force: { type: "boolean" },
    },
  });
  if ([values.zip, values.bundle, values.report].filter(Boolean).length > 1) {
    throw new Error("pick one of --zip, --bundle or --report");
  }
  const { exportReport, exportRun, resolveRun } = await import("./runs.js");
  const dir = resolveRun(positionals[0]);
  const format: "zip" | "bundle" | "report" = values.report ? "report" : values.bundle ? "bundle" : "zip";
  const runName = basename(dir);
  const ext = format === "report" ? "md" : format;
  const outPath = values.output ?? join(process.cwd(), `${runName}.${ext}`);
  if (existsSync(outPath) && !values.force) throw new Error(`${outPath} already exists; use --force to overwrite`);
  if (format === "report") {
    const report = exportReport(dir, outPath);
    process.stdout.write(`hive: wrote report for ${runName} to ${report.path}\n`);
    return 0;
  }
  const result = await exportRun(dir, format, outPath);
  process.stdout.write(`hive: exported ${result.commits} commit(s) to ${result.path}\n`);
  if (format === "bundle") process.stdout.write(`git clone ${result.path} ${runName}\n`);
  return 0;
}

async function cmdPush(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      branch: { type: "string" },
      remote: { type: "string" },
      pr: { type: "boolean" },
      base: { type: "string" },
      yes: { type: "boolean" },
    },
  });
  if (values.base !== undefined && !values.pr) throw new Error("--base needs --pr");
  const { openPr, pushRun, readMeta, resolveRun } = await import("./runs.js");
  const dir = resolveRun(positionals[0]);
  const meta = readMeta(dir);

  const push = (confirmWarnings: boolean) =>
    pushRun(dir, {
      branch: values.branch,
      remote: values.remote,
      requireGithub: !!values.pr,
      update: meta.pushed !== undefined,
      confirmWarnings,
    });

  let result: Awaited<ReturnType<typeof pushRun>>;
  try {
    result = await push(!!values.yes);
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === "OUTPUT_SCAN_BLOCKED") {
      console.error(forTerminal(`hive: ${(err as Error).message}`, process.stderr));
      return 1;
    }
    if (code !== "OUTPUT_SCAN_WARNINGS") throw err;

    // The fresh scan was saved before pushRun refused, so list exactly what it found.
    const scan = readMeta(dir).outputScan;
    const warnings = scan?.findings.filter((f) => f.level === "warn") ?? [];
    const lines = warnings.map((f) => `  ${f.kind} ${plainText(f.file)}`);
    const list = `hive: push needs confirmation:\n${lines.join("\n")}`;
    const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
    if (!interactive) {
      console.error(forTerminal(list, process.stderr));
      console.error("hive: rerun with --yes to push");
      return 1;
    }
    console.error(forTerminal(list, process.stderr));
    const answer = await ask("Push anyway? [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.error("hive: not pushed");
      return 1;
    }
    result = await push(true);
  }
  process.stdout.write(`hive: pushed ${result.commits} commit(s) to ${result.branch} on ${result.url}\n`);
  if (values.pr) process.stdout.write((await openPr(dir, { base: values.base })) + "\n");
  return 0;
}

async function cmdList(args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true });
  const { listRuns, recoverRuns } = await import("./runs.js");
  recoverRuns();
  const runs = listRuns();
  if (runs.length === 0) {
    process.stdout.write("no runs\n");
    return 0;
  }
  if (colorEnabled(process.stdout)) {
    const tty = process.stdout.isTTY === true;
    const now = Date.now();
    const rows: string[][] = [["RUN", "STATUS", "COMMITS", "COST", "AGE", "REPO"]];
    for (const run of runs) {
      const star = run.meta.kept ? " \u2605" : "";
      const offline = run.meta.offline === true ? " offline" : "";
      rows.push([
        run.name,
        runStatusCell(run.meta.status, tty) + star + offline,
        String(run.meta.commits),
        formatCost(run.meta.usage.cost),
        runAge(run.meta, now),
        run.meta.repo,
      ]);
    }
    process.stdout.write(table(rows, { header: true, enabled: true }) + "\n");
    return 0;
  }
  for (const run of runs) {
    const star = run.meta.kept ? " \u2605" : "";
    const offline = run.meta.offline === true ? " offline" : "";
    process.stdout.write(
      `${run.name}  ${run.meta.status}${star}${offline}  ${run.meta.commits} commit(s)  $${run.meta.usage.cost.toFixed(4)}  ${run.meta.repo}\n`,
    );
  }
  return 0;
}

async function cmdClean(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { all: { type: "boolean" } },
  });
  const { cleanRun, isLive, listRuns, resolveRun } = await import("./runs.js");
  if (values.all) {
    for (const run of listRuns()) {
      if (isLive(run.meta)) {
        console.error(`hive: kept ${run.name} (still running)`);
        continue;
      }
      if (run.meta.kept) {
        console.error(`hive: kept ${run.name} (starred)`);
        continue;
      }
      cleanRun(run.dir);
      process.stdout.write(`hive: cleaned ${run.name}\n`);
    }
    return 0;
  }
  if (positionals.length === 0) {
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      const finished = listRuns().filter((run) => !isLive(run.meta));
      if (finished.length === 0) throw new Error("no finished runs to clean");
      const dir = await select(
        "Which run should be deleted?",
        finished.map((run) => ({
          label: run.name,
          value: run.dir,
          hint: `${run.meta.status}, ${runAge(run.meta)}`,
        })),
      );
      cleanRun(dir);
      process.stdout.write(`hive: cleaned ${basename(dir)}\n`);
      return 0;
    }
    throw new Error("clean needs a run name or --all");
  }
  const dir = resolveRun(positionals[0]);
  cleanRun(dir);
  process.stdout.write(`hive: cleaned ${basename(dir)}\n`);
  return 0;
}

async function cmdKeep(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { off: { type: "boolean" } },
  });
  const { resolveRun, setKept } = await import("./runs.js");
  if (positionals[0] === undefined) throw new Error("keep needs a run name");
  const dir = resolveRun(positionals[0]);
  setKept(dir, !values.off);
  const name = basename(dir);
  process.stdout.write(values.off ? `hive: unstarred ${name}\n` : `hive: starred ${name}\n`);
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Prompt for a secret with echo off; used when `hive keys add` runs on a terminal. */
function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdout.write("\n");
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          cleanup();
          reject(new Error("aborted"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function cmdKeysList(): Promise<number> {
  const { PROVIDERS, effectiveModel, providerKey, resolveProvider, shellEnv } = await import("./config.js");
  const { keySource, maskKey, readKeysFile } = await import("./keys.js");
  const fileValues = readKeysFile();
  const resolved = resolveProvider();
  const defaultProvider =
    resolved !== undefined && PROVIDERS[resolved] && providerKey(resolved) ? resolved : undefined;
  const sourceText: Record<string, string> = { environment: "environment", saved: "saved", "env-file": ".env" };
  const rows = Object.keys(PROVIDERS).map((id) => {
    const provider = PROVIDERS[id];
    const found = keySource(provider.hostEnv, shellEnv, process.env, fileValues);
    return {
      label: provider.label,
      key: found ? maskKey(found.value) : "no key",
      source: found ? sourceText[found.source] : "-",
      model: effectiveModel(id) ?? "none",
      isDefault: id === defaultProvider,
    };
  });
  if (colorEnabled(process.stdout)) {
    const tableRows: string[][] = [["PROVIDER", "KEY", "SOURCE", "DEFAULT MODEL"]];
    for (const row of rows) {
      tableRows.push([
        row.isDefault ? symbols.running + " " + row.label : row.label,
        row.key,
        row.source,
        row.model,
      ]);
    }
    process.stdout.write(table(tableRows, { header: true, enabled: true }) + "\n");
    return 0;
  }
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const keyWidth = Math.max(...rows.map((r) => r.key.length));
  const sourceWidth = Math.max(...rows.map((r) => r.source.length));
  for (const row of rows) {
    process.stdout.write(
      `${row.label.padEnd(labelWidth)}  ${row.key.padEnd(keyWidth)}  ${row.source.padEnd(sourceWidth)}  ${row.model}${row.isDefault ? " (default)" : ""}\n`,
    );
  }
  return 0;
}

async function cmdKeysAdd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { "no-test": { type: "boolean" } },
  });
  const { PROVIDERS } = await import("./config.js");
  let provider = positionals[0];
  if (provider === undefined) {
    if (process.stdin.isTTY !== true) throw new Error("keys add needs a provider");
    provider = await select(
      "Which provider?",
      Object.keys(PROVIDERS).map((id) => ({ label: PROVIDERS[id].label, value: id })),
    );
  }
  const { keysFilePath, setKeysFileValue, testKey } = await import("./keys.js");
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`unknown provider "${provider}"; supported: ${Object.keys(PROVIDERS).join(", ")}`);
  const key = process.stdin.isTTY ? await promptHidden(`Paste the ${entry.label} API key: `) : await readStdin();
  if (!key) throw new Error("no key given");
  if (!values["no-test"]) {
    const result = await testKey(provider, key);
    if (result.status === "refused") {
      console.error(`hive: ${result.detail}; nothing was saved`);
      return 1;
    }
    if (result.status === "unchecked") console.error(`hive: warning: ${result.detail}; saving it anyway`);
    else process.stdout.write(`${result.detail}.\n`);
  }
  setKeysFileValue(entry.hostEnv[0], key);
  process.stdout.write(`Saved the ${entry.label} key to ${keysFilePath()}\n`);
  return 0;
}

async function cmdKeysTest(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const { PROVIDERS, shellEnv } = await import("./config.js");
  const { keySource, readKeysFile, testKey } = await import("./keys.js");
  const fileValues = readKeysFile();
  const testOne = async (provider: string): Promise<boolean> => {
    const entry = PROVIDERS[provider];
    const found = keySource(entry.hostEnv, shellEnv, process.env, fileValues);
    if (!found) {
      console.error(`hive: no key for ${entry.label}`);
      return false;
    }
    const result = await testKey(provider, found.value);
    process.stdout.write(`${entry.label}: ${result.status} - ${result.detail}\n`);
    return result.status === "refused";
  };
  const provider = positionals[0];
  if (provider !== undefined) {
    if (!PROVIDERS[provider]) throw new Error(`unknown provider "${provider}"; supported: ${Object.keys(PROVIDERS).join(", ")}`);
    return (await testOne(provider)) ? 1 : 0;
  }
  let refused = false;
  for (const id of Object.keys(PROVIDERS)) {
    const found = keySource(PROVIDERS[id].hostEnv, shellEnv, process.env, fileValues);
    if (!found) continue;
    if (await testOne(id)) refused = true;
  }
  return refused ? 1 : 0;
}

async function cmdKeysRemove(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const provider = positionals[0];
  if (!provider) throw new Error("keys remove needs a provider");
  const { PROVIDERS, shellEnv } = await import("./config.js");
  const { keySource, keysFilePath, readKeysFile, setKeysFileValue } = await import("./keys.js");
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`unknown provider "${provider}"; supported: ${Object.keys(PROVIDERS).join(", ")}`);
  const fileValues = readKeysFile();
  const found = keySource(entry.hostEnv, shellEnv, process.env, fileValues);
  if (found?.source === "environment") {
    console.error(`hive: ${found.name} is set in the environment; unset it there instead`);
    return 1;
  }
  if (!entry.hostEnv.some((name) => fileValues[name])) {
    console.error(`hive: no saved key for ${entry.label}`);
    return 1;
  }
  for (const name of entry.hostEnv) setKeysFileValue(name, null);
  if (fileValues.DEFAULT_PROVIDER === provider) setKeysFileValue("DEFAULT_PROVIDER", null);
  process.stdout.write(`Removed the ${entry.label} key from ${keysFilePath()}\n`);
  return 0;
}

async function cmdKeysDefault(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const { PROVIDERS, providerKey } = await import("./config.js");
  let provider = positionals[0];
  if (provider === undefined) {
    if (process.stdin.isTTY !== true) throw new Error("keys default needs a provider");
    const available = Object.keys(PROVIDERS).filter((id) => providerKey(id));
    if (available.length === 0) throw new Error("no provider has a key; add one with hive keys add");
    provider = await select(
      "Which provider should be the default?",
      available.map((id) => ({ label: PROVIDERS[id].label, value: id })),
    );
  }
  const { keysFilePath, setKeysFileValue } = await import("./keys.js");
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`unknown provider "${provider}"; supported: ${Object.keys(PROVIDERS).join(", ")}`);
  if (!providerKey(provider)) {
    console.error(`hive: ${entry.label} has no key; add one first`);
    return 1;
  }
  setKeysFileValue("DEFAULT_PROVIDER", provider);
  process.stdout.write(`${entry.label} is now the default provider (${keysFilePath()})\n`);
  return 0;
}

async function cmdKeys(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "list":
      return cmdKeysList();
    case "add":
      return cmdKeysAdd(rest);
    case "test":
      return cmdKeysTest(rest);
    case "remove":
      return cmdKeysRemove(rest);
    case "default":
      return cmdKeysDefault(rest);
    default:
      throw new Error(`unknown keys command "${sub}"; try hive keys list`);
  }
}

/** A --host / --port pair with the defaults and the validation `hive serve` uses. */
function serveTarget(values: { host?: string; port?: string }): { host: string; port: number } {
  const host = values.host ?? process.env.HOST ?? "127.0.0.1";
  const rawPort = values.port ?? process.env.PORT ?? "8080";
  if (!/^\d+$/.test(rawPort)) throw new Error(`--port must be 1-65535, got "${rawPort}"`);
  const port = Number(rawPort);
  if (port < 1 || port > 65535) throw new Error(`--port must be 1-65535, got "${rawPort}"`);
  return { host, port };
}

/**
 * Create and save a login token when none is configured (neither API_TOKEN nor API_TOKENS, in the
 * shell, the keys file or .env). Returns the new token when it made one.
 */
async function ensureLoginToken(): Promise<string | undefined> {
  const { setting } = await import("./config.js");
  if (setting("API_TOKEN") || setting("API_TOKENS")) return undefined;
  const { keysFilePath, setKeysFileValue } = await import("./keys.js");
  const token = randomBytes(24).toString("hex");
  setKeysFileValue("API_TOKEN", token);
  process.stdout.write(`hive: created a login token and saved it to ${keysFilePath()}\n`);
  return token;
}

/** Poll the server's /health until it answers, or the timeout runs out. */
async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  return false;
}

/** True under WSL: its kernel version names Microsoft. */
function isWsl(): boolean {
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Open a URL in the user's browser; `onFailure` runs when no opener could be started. Under WSL
 * the Windows browser is used: `wslview` when installed, else `cmd.exe /c start`.
 */
function openBrowser(url: string, onFailure: () => void): void {
  const tryOpen = (command: string, args: string[], next: () => void) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("error", next);
      child.unref();
    } catch {
      next();
    }
  };
  if (process.platform === "darwin") return tryOpen("open", [url], onFailure);
  if (isWsl()) {
    // The URL is ours (127.0.0.1 and a hex token), so nothing in it means anything to cmd.exe.
    return tryOpen("wslview", [url], () => tryOpen("cmd.exe", ["/c", "start", "", url], onFailure));
  }
  tryOpen("xdg-open", [url], onFailure);
}

async function cmdServe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      open: { type: "boolean" },
      "no-open": { type: "boolean" },
    },
  });
  const { host, port } = serveTarget(values);
  // Before anything imports ./config.ts: it reads HOST and PORT once, at import time.
  process.env.HOST = host;
  process.env.PORT = String(port);

  const created = await ensureLoginToken();
  const { shellEnv } = await import("./config.js");
  const { keySource, keysFilePath, readKeysFile } = await import("./keys.js");
  const configured =
    created === undefined ? keySource(["API_TOKEN"], shellEnv, process.env, readKeysFile()) : undefined;
  const token = created ?? configured?.value;
  // A token that lives only in the keys file has to be in the environment too: loadTokens() runs
  // after config.ts was imported, so its shell-environment snapshot may predate the check above.
  if (token !== undefined) process.env.API_TOKEN = token;

  await import("./index.js");

  const hint = `hive: log in with the token in ${keysFilePath()} (hive keys list does not show it; see API_TOKEN there)`;
  if (!(await waitForHealth(port, 15_000))) {
    throw new Error(`the server did not answer on http://127.0.0.1:${port}/health; is the port free?`);
  }
  process.stdout.write(`hive: serving on http://${host}:${port}/ui/\n`);
  if (host === "0.0.0.0") {
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === "IPv4" && !address.internal) {
          process.stdout.write(`hive: also on http://${address.address}:${port}/ui/ (${name})\n`);
        }
      }
    }
  }
  process.stdout.write(`${hint}\n`);

  if (shouldOpenBrowser(values, process.env, { tty: Boolean(process.stdout.isTTY), platform: process.platform, wsl: isWsl() })) {
    const base = `http://127.0.0.1:${port}/ui/`;
    const url = token === undefined ? base : `${base}#token=${token}`;
    openBrowser(url, () => {
      process.stdout.write(`hive: couldn't open a browser; go to ${base}\n${hint}\n`);
    });
  }

  // The server keeps its own handles; Ctrl+C is a normal, successful stop.
  process.on("SIGINT", () => process.exit(0));
  return 0;
}

/** Warn about provider keys that only exist in this shell: a service won't inherit them. */
async function warnShellOnlyKeys(): Promise<void> {
  const { PROVIDERS, shellEnv } = await import("./config.js");
  const { readKeysFile } = await import("./keys.js");
  const fileValues = readKeysFile();
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const inShell = provider.hostEnv.some((name) => shellEnv[name]);
    const inFile = provider.hostEnv.some((name) => fileValues[name]);
    if (inShell && !inFile) {
      process.stderr.write(
        `hive: ${provider.label} key comes from your shell; the service won't see it. Save it with: hive keys add ${id}\n`,
      );
    }
  }
}

async function cmdService(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) throw new Error("hive service needs install, status, restart, logs or uninstall");
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const dryRun = values["dry-run"] ?? false;
  const service = await import("./service.js");
  switch (sub) {
    case "install": {
      const { host, port } = serveTarget(values);
      await ensureLoginToken();
      await warnShellOnlyKeys();
      const result = service.installService({ host, port, dryRun });
      if (dryRun) {
        process.stdout.write(`hive: would write ${result.file}\n`);
        process.stdout.write(result.content);
      } else {
        process.stdout.write(`hive: wrote ${result.file}\n`);
        process.stdout.write(`hive: started; open http://${host}:${port}/ui/\n`);
        if (result.lingerHint !== undefined) process.stdout.write(`${result.lingerHint}\n`);
      }
      return 0;
    }
    case "status": {
      const { installed } = service.statusService({ dryRun });
      if (!installed) process.stdout.write("hive: not installed\n");
      return 0;
    }
    case "restart":
      service.restartService({ dryRun });
      if (!dryRun) process.stdout.write("hive: restarted\n");
      return 0;
    case "logs":
      return service.logsService({ dryRun });
    case "uninstall":
      service.uninstallService({ dryRun });
      if (!dryRun) process.stdout.write("hive: uninstalled\n");
      return 0;
    default:
      throw new Error(`unknown service command "${sub}"; try hive service install`);
  }
}

/** A path with the home folder shortened to `~`, for the uninstall plan. */
function tildePath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

type UninstallModule = typeof import("./uninstall.js");

/** Print the paths an uninstall would remove, one per line, with sizes where they are known. */
function printUninstallPlan(plan: UninstallPlan, u: UninstallModule): void {
  const { uninstallEntries, sizeLabel } = u;
  const rows = uninstallEntries(plan).filter((entry) => entry.exists);
  const labelWidth = Math.max(0, ...rows.map((row) => row.label.length));
  const pathWidth = Math.max(0, ...rows.map((row) => tildePath(row.path).length));
  const lines = ["hive: this will remove:"];
  if (rows.length === 0) lines.push("  (no installed hive files found)");
  for (const row of rows) {
    const label = row.label.padEnd(labelWidth);
    const path = tildePath(row.path).padEnd(pathWidth);
    const size = row.bytes === undefined ? "" : `  ${sizeLabel(row.bytes)}`;
    lines.push(`  ${label}  ${path}${size}`.trimEnd());
  }
  for (const lineFile of plan.pathLines) {
    lines.push(`  ${"the PATH line it added".padEnd(labelWidth)}  ${tildePath(lineFile.file)}`);
  }
  if (plan.service) lines.push(`  ${"the background service".padEnd(labelWidth)}`);
  if (plan.sourceInstall) {
    lines.push("  (the hive command comes from a source checkout and is left alone)");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * `hive uninstall`: show what goes, ask (unless --yes), delete it. Runs and saved keys/settings
 * are kept by default. Nothing that is needed after deleting is imported or read at that point:
 * every line printed afterwards was built before the first file went.
 */
async function cmdUninstall(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      yes: { type: "boolean" },
      all: { type: "boolean" },
      "keep-runs": { type: "boolean" },
      "keep-config": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });
  if (positionals.length > 0) throw new Error(`unexpected argument: ${positionals[0]}`);

  const u = await import("./uninstall.js");
  const { uninstallPlan, runUninstall, sizeLabel } = u;
  const yes = values.yes === true;
  const all = values.all === true;
  const keepRunsFlag = values["keep-runs"] === true;
  const keepConfigFlag = values["keep-config"] === true;
  const dryRun = values["dry-run"] === true;
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const wsl = isWsl();
  // The default: `--all` (or the interactive answers) removes runs and keys too; --keep-* wins.
  const keepRuns = keepRunsFlag || !all;
  const keepConfig = keepConfigFlag || !all;

  const finish = (plan: UninstallPlan): number => {
    const { lines, failed } = runUninstall(plan, { dryRun });
    for (const line of lines) process.stdout.write(`hive: ${line}\n`);
    if (dryRun) return 0;
    if (plan.sourceInstall) {
      process.stdout.write(
        "hive: this copy runs from a source checkout; remove the checkout yourself (and run npm unlink in it)\n",
      );
    }
    if (wsl) {
      const distro = process.env.WSL_DISTRO_NAME || "agent-hive";
      process.stdout.write(
        `hive: to remove the whole WSL distro too, run in Windows: wsl --unregister ${distro}\n`,
      );
    }
    if (failed.length > 0) {
      const paths = failed.filter((failure) => failure.kind === "path");
      const profiles = failed.filter((failure) => failure.kind === "lines");
      process.stdout.write(
        `hive: ${failed.length} thing${failed.length === 1 ? "" : "s"} could not be removed:\n`,
      );
      for (const failure of failed) {
        process.stdout.write(`  ${tildePath(failure.path)} (${failure.reason})\n`);
      }
      // A root-owned path from a run started with sudo is the usual case; hive itself never runs
      // as root, so it cannot clean these up itself.
      const denied = paths.filter((failure) => failure.reason === "permission denied");
      const stuck = paths.filter((failure) => failure.reason !== "permission denied");
      if (denied.length > 0) {
        process.stdout.write(
          "hive: they belong to another user (a run started with sudo leaves root-owned files); hive never uses sudo.\n",
        );
        process.stdout.write(
          `hive: finish with: sudo rm -rf ${denied.map((failure) => `'${failure.path}'`).join(" ")}\n`,
        );
      }
      if (stuck.length > 0) {
        process.stdout.write("hive: something is still using them; close it and remove them by hand:\n");
        process.stdout.write(
          `hive:   rm -rf ${stuck.map((failure) => `'${failure.path}'`).join(" ")}\n`,
        );
      }
      for (const failure of profiles) {
        process.stdout.write(
          `hive: delete the "# added by agent-hive" lines from ${tildePath(failure.path)} yourself\n`,
        );
      }
      return 1;
    }
    process.stdout.write("hive: uninstalled. Open a new terminal so your PATH no longer has ~/.local/bin/hive.\n");
    return 0;
  };

  if (interactive && !yes && !dryRun) {
    const base = uninstallPlan({ keepRuns, keepConfig });
    printUninstallPlan(base, u);

    // The sizes and run count for the questions: what a full uninstall would remove.
    const full = uninstallPlan({ keepRuns: false, keepConfig: false });
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const askYesNo = async (question: string): Promise<boolean> =>
      /^y(es)?$/i.test((await rl.question(question)).trim());
    try {
      let deleteRuns = all && !keepRunsFlag;
      if (!keepRunsFlag && !all && full.runsCount > 0) {
        const size = sizeLabel(full.runs === undefined ? undefined : full.sizes[full.runs]);
        deleteRuns = await askYesNo(
          `Also delete your runs (${full.runsCount} run${full.runsCount === 1 ? "" : "s"}, ${size})? [y/N] `,
        );
      }
      let deleteConfig = all && !keepConfigFlag;
      if (!keepConfigFlag && !all && full.config !== undefined && existsSync(full.config)) {
        deleteConfig = await askYesNo(
          `Also delete saved API keys and settings (${tildePath(full.config)})? [y/N] `,
        );
      }
      if (!(await askYesNo("Uninstall hive? [y/N] "))) {
        process.stdout.write("hive: cancelled\n");
        return 1;
      }
      return finish(uninstallPlan({ keepRuns: !deleteRuns, keepConfig: !deleteConfig }));
    } finally {
      rl.close();
    }
  }

  const plan = uninstallPlan({ keepRuns, keepConfig });
  printUninstallPlan(plan, u);
  if (!yes && !dryRun) {
    process.stderr.write(
      "hive: run hive uninstall --yes to remove it (add --all to also remove runs and keys)\n",
    );
    return 1;
  }
  return finish(plan);
}

/** What a working sandbox needs on this platform, for the "can't start a VM" message. */
function sandboxRequirements(): string {
  return process.platform === "darwin"
    ? "hive needs Hypervisor.framework (Apple silicon, macOS 14 or newer), libkrun, the launcher (npm run build:vm) and the VM image (docs/MACOS.md)"
    : "hive needs /dev/kvm, pasta, libkrun, the launcher (npm run build:vm) and the rootfs (npm run build:rootfs)";
}

function kvmState(): "ok" | "missing" | "no access" {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return "ok";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "no access";
  }
}

async function cmdDoctor(args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true });
  const { config, providerInfo } = await import("./config.js");
  const { hardwareVirtualization, libkrunAvailable, networkBackend } = await import("./sandbox.js");
  const { libkrunChoice, libkrunLabel } = await import("./libkrun.js");
  const { pastaChoice, pastaLabel } = await import("./pasta.js");
  const { currentVersion } = await import("./release.js");
  const { fixFor, hostInfo } = await import("./fixes.js");
  type CheckId = Parameters<typeof fixFor>[0];
  const host = hostInfo();

  let allOk = true;
  const version = `hive ${versionLabel(currentVersion())}`;
  // Plain output is `<label>: <detail>` for every check, exactly as before; the terminal view
  // replaces the colon with a ✓/✗ and keeps the same fix hint in the detail. A failed check that
  // has a distro-aware fix prints its text and command on the lines below.
  const checks: { ok: boolean; label: string; detail: string; id?: CheckId }[] = [];
  const notes: string[] = [];

  if (networkBackend() === "vsock") {
    const hvf = hardwareVirtualization();
    checks.push({ ok: hvf, id: "kvm", label: "Hypervisor.framework", detail: hvf ? "ok" : "unavailable" });
    if (!hvf) allOk = false;
  } else {
    const kvm = kvmState();
    checks.push({ ok: kvm === "ok", id: "kvm", label: "/dev/kvm", detail: kvm });
    if (kvm !== "ok") allOk = false;
  }

  const libkrun = libkrunChoice();
  checks.push({
    ok: libkrun.ok,
    id: "libkrun",
    label: "libkrun",
    detail: libkrun.ok ? `ok (${libkrunLabel(libkrun)}: ${libkrun.path})` : "not found",
  });
  if (!libkrun.ok) allOk = false;

  if (networkBackend() === "vsock") {
    // Nothing separate to install: the bridge lives in hive and the launcher maps the one port.
    checks.push({ ok: true, id: "network", label: "vsock egress", detail: "ok (one port to hive's egress proxy)" });
  } else {
    const pasta = pastaChoice();
    checks.push({
      ok: pasta.ok,
      id: "pasta",
      label: "pasta",
      detail: pasta.ok ? `ok (${pastaLabel(pasta)}: ${pasta.path})` : "not found",
    });
    if (!pasta.ok) allOk = false;
  }

  const launcherOk = existsSync(config.sandbox.vmBin);
  checks.push({
    ok: launcherOk,
    id: "launcher",
    label: "launcher",
    detail: launcherOk ? `ok (${config.sandbox.vmBin})` : `missing (${config.sandbox.vmBin})`,
  });
  if (!launcherOk) allOk = false;

  let rootfsOk = false;
  let rootfsPath = config.sandbox.rootfs;
  try {
    rootfsPath = realpathSync(config.sandbox.rootfs);
    rootfsOk =
      networkBackend() === "vsock"
        ? statSync(rootfsPath).isFile()
        : existsSync(join(rootfsPath, "usr/local/bin/hive-vm-init"));
  } catch {
    rootfsOk = false;
  }
  checks.push({
    ok: rootfsOk,
    id: "rootfs",
    label: "rootfs",
    // On macOS the image does not exist yet, so "run hive setup" would loop: setup is Linux-only.
    detail: rootfsOk
      ? `ok (${rootfsPath})`
      : `missing (${config.sandbox.rootfs}) — ${
          networkBackend() === "vsock"
            ? "the macOS VM image is not installed (npm run build:rootfs-image on arm64 Linux; docs/MACOS.md)"
            : "run hive setup"
        }`,
  });
  if (!rootfsOk) allOk = false;

  const isolationOk = libkrunAvailable();
  checks.push({
    ok: isolationOk,
    label: "isolation",
    detail: isolationOk ? `microvm (${libkrunLabel(libkrun)})` : "unavailable",
  });
  if (!isolationOk) allOk = false;

  const providers = providerInfo();
  const def = providers.default;
  if (def.provider !== null) {
    notes.push(
      def.providerSource === "DEFAULT_PROVIDER"
        ? `provider: ${def.provider} (DEFAULT_PROVIDER)`
        : `provider: ${def.provider} (first provider with a key; set DEFAULT_PROVIDER to choose)`,
    );
  } else if (process.env.DEFAULT_PROVIDER) {
    notes.push(
      `provider: unknown "${process.env.DEFAULT_PROVIDER}" (DEFAULT_PROVIDER); supported: deepseek, zai, openrouter, anthropic, openai`,
    );
  } else {
    notes.push("provider: none (no API key set)");
  }
  if (def.model !== null) {
    notes.push(
      def.modelSource === "DEFAULT_MODEL"
        ? `model: ${def.model} (DEFAULT_MODEL)`
        : `model: ${def.model} (${def.provider}'s default)`,
    );
  }
  notes.push(`thinking: ${def.thinking}`);

  const lines: string[] = [];
  const fixLines = (check: (typeof checks)[number], tty: boolean): void => {
    if (check.ok || check.id === undefined) return;
    const fix = fixFor(check.id, host, check.detail);
    lines.push(tty ? dim(`  ${fix.text}`, true) : `  ${fix.text}`);
    if (fix.command !== undefined) {
      lines.push(tty ? `  $ ${cyan(fix.command, true)}` : `  $ ${fix.command}`);
    }
  };
  if (colorEnabled(process.stdout)) {
    lines.push(bold(version));
    for (const check of checks) {
      lines.push(`${check.ok ? green(symbols.done, true) : red(symbols.failed, true)} ${check.label}  ${check.detail}`);
      fixLines(check, true);
    }
    for (const note of notes) lines.push(dim(note, true));
  } else {
    lines.push(version);
    for (const check of checks) {
      lines.push(`${check.label}: ${check.detail}`);
      fixLines(check, false);
    }
    lines.push(...notes);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return allOk ? 0 : 1;
}

/** Whole MB, 1 decimal below 100 MB and none above it. */
function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(bytes >= 100_000_000 ? 0 : 1);
}

/**
 * Progress for a release download (`hive setup` and `hive update`), on stderr: one redrawn line on
 * a terminal, a line every 10% otherwise. `label` says what is being downloaded; `done` finishes
 * the line.
 */
function downloadProgress(label: string): {
  onProgress: (p: { received: number; total: number | undefined }) => void;
  done: () => void;
} {
  const tty = Boolean(process.stderr.isTTY);
  let started = false;
  let finished = false;
  let lastDraw = 0;
  let bucket = -1;
  let openLine = false;
  const onProgress = (p: { received: number; total: number | undefined }): void => {
    if (!started) {
      started = true;
      const size = p.total === undefined ? "" : ` — ${megabytes(p.total)} MB`;
      process.stderr.write(`hive: downloading ${label}${size}…\n`);
    }
    const total = p.total;
    const pct =
      total === undefined ? undefined : total === 0 ? 100 : Math.min(100, Math.floor((p.received / total) * 100));
    const totalText = total === undefined ? "?" : megabytes(total);
    const pctText = pct === undefined ? "?" : String(pct);
    if (tty) {
      const now = Date.now();
      if (pct === 100 && !finished) {
        process.stderr.write(`\r  ${megabytes(p.received)} / ${totalText} MB (100%)\n`);
        finished = true;
        openLine = false;
        return;
      }
      if (finished || now - lastDraw < 250) return;
      lastDraw = now;
      process.stderr.write(`\r  ${megabytes(p.received)} / ${totalText} MB (${pctText}%)`);
      openLine = true;
    } else {
      const next = pct === undefined ? -1 : Math.floor(pct / 10);
      if (next === bucket) return;
      bucket = next;
      process.stderr.write(`hive: ${megabytes(p.received)} / ${totalText} MB (${pctText}%)\n`);
    }
  };
  const done = (): void => {
    if (openLine) process.stderr.write("\n");
  };
  return { onProgress, done };
}

/** Find an executable on PATH, without a shell (used for wslview on WSL). */
function onPath(name: string): boolean {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this directory.
    }
  }
  return false;
}

/** `hive login github`: gh's own device login, with its prompts on this terminal. */
async function cmdLogin(args: string[]): Promise<number> {
  const [target, ...extra] = args;
  if (target !== "github" || extra.length > 0) {
    process.stderr.write("hive login github\n");
    return 1;
  }
  const ghBin = process.env.GH_BIN || "gh";
  const env: NodeJS.ProcessEnv = { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" };
  // On WSL, gh would look for a Linux browser; wslview opens the Windows one.
  if (!env.BROWSER) {
    const { hostInfo } = await import("./fixes.js");
    if (hostInfo().wsl && onPath("wslview")) env.BROWSER = "wslview";
  }
  const login = spawnSync(ghBin, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "workflow"], {
    stdio: "inherit",
    env,
  });
  if (login.error) {
    if ((login.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("gh is not installed on this computer; install the GitHub CLI (gh)");
    }
    throw new Error(`couldn't run gh: ${login.error.message}`);
  }
  if (login.status !== 0) return login.status ?? 1;
  const setup = spawnSync(ghBin, ["auth", "setup-git"], { stdio: "inherit", env });
  if (setup.error || setup.status !== 0) {
    process.stderr.write("hive: warning: gh auth setup-git failed; git may not use the GitHub login\n");
  }
  const { githubLogin } = await import("./git.js");
  const name = await githubLogin();
  process.stdout.write(`hive: signed in to GitHub as ${name}\n`);
  return 0;
}

async function cmdSetup(args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true });
  const { bundleRoot, setupRootfs } = await import("./release.js");
  if (bundleRoot()) {
    const progress = downloadProgress("the VM filesystem (one time)");
    const path = await setupRootfs({ onProgress: progress.onProgress });
    progress.done();
    process.stdout.write(`hive: VM filesystem ready: ${path}\n`);
  } else if (process.platform === "darwin") {
    // The Linux recipe builds a folder rootfs, which the macOS launcher refuses: say what is
    // actually missing instead of sending the user to a command that cannot help.
    process.stdout.write(
      "hive: running from source; build the arm64 VM image on arm64 Linux with npm run build:rootfs-image, then set HIVE_ROOTFS to the .img (docs/MACOS.md)\n",
    );
  } else {
    process.stdout.write(
      "hive: running from source; build the VM filesystem with npm run build:image && npm run build:rootfs\n",
    );
  }
  return cmdDoctor([]);
}

async function cmdUpdate(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      check: { type: "boolean" },
      rollback: { type: "boolean" },
      // A specific signed release, e.g. `v0.5.8`. Stable releases are the default. Test builds are
      // unsigned, so they cannot be installed this way: run one from source, or promote it first.
      tag: { type: "string" },
    },
  });
  const {
    activate,
    bundleRoot,
    compareVersions,
    currentVersion,
    fetchRelease,
    installRelease,
    isPrerelease,
    prune,
    rollback,
  } = await import("./release.js");
  if (!bundleRoot()) {
    throw new Error(
      "hive update works for installed releases; this copy runs from source (git pull && npm run build)",
    );
  }
  const cur = currentVersion() ?? "dev";

  if (values.rollback) {
    const version = rollback();
    process.stdout.write(`hive: back on ${version}\n`);
    return 0;
  }

  const wanted = values.tag;
  const rel = await fetchRelease(wanted);

  // Asking for a tag means asking for exactly that build, so the 'you are newer than stable'
  // guard and the version comparison below do not apply: an explicit tag is installed as it is.
  if (wanted !== undefined) {
    process.stdout.write(`hive: installing ${wanted} (you have ${cur})\n`);
    const progress = downloadProgress(`the VM filesystem for ${wanted}`);
    try {
      await installRelease(rel, { onProgress: progress.onProgress });
    } finally {
      progress.done();
    }
    activate(rel.version);
    prune();
    process.stdout.write(`hive: updated ${cur} → ${rel.version} (${wanted})\n`);
    return 0;
  }

  // An install left on an old prerelease must not be downgraded by the move to stable.
  if (isPrerelease(cur) && compareVersions(cur, rel.version) > 0) {
    process.stdout.write(
      `hive ${cur} is newer than the latest stable release (${rel.version}); you'll get the next stable release\n`,
    );
    return 0;
  }

  if (values.check) {
    if (compareVersions(rel.version, cur) > 0) {
      process.stdout.write(`hive ${rel.version} is available (you have ${cur})\n`);
    } else {
      process.stdout.write(`hive ${cur} is up to date\n`);
    }
    return 0;
  }

  if (compareVersions(rel.version, cur) <= 0) {
    process.stdout.write(`hive ${cur} is up to date\n`);
    return 0;
  }
  // The VM filesystem is ~700 MB: say so and show it moving, or an update looks frozen.
  process.stdout.write(`hive: updating ${cur} → ${rel.version}\n`);
  const progress = downloadProgress(`the VM filesystem for ${rel.version}`);
  try {
    await installRelease(rel, { onProgress: progress.onProgress });
  } finally {
    progress.done();
  }
  activate(rel.version);
  prune();
  process.stdout.write(`hive: updated ${cur} → ${rel.version}\n`);
  return 0;
}

/**
 * The user's git config value for `key`, or undefined. Local copy of gitConfigIdentity(): the
 * identity has to be in the environment before ./config.ts is first imported.
 */
function gitConfigValue(key: string): string | undefined {
  try {
    const value = execFileSync("git", ["config", "--get", key], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The version to show: the release's VERSION file, or, from a checkout, what git says the checkout
 * is ("from source: <sha> on <branch>, N commits after vX"). package.json's version is the last
 * resort: releases are numbered at build time, so it is never bumped and names an old release.
 */
function versionLabel(released: string | undefined): string {
  if (released) return released;
  const source = sourceDescription();
  if (source) return source;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof pkg.version === "string") return `${pkg.version} (from source)`;
  } catch {
    // no package.json: fall through
  }
  return "dev (from source)";
}

async function main(): Promise<void> {
  process.env.HIVE_DOTENV_PATH ||= join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "agent-hive/env",
  );
  const runtime = process.env.HIVE_RUNTIME;
  if (runtime && runtime !== "libkrun") {
    console.error("hive: the CLI only supports HIVE_RUNTIME=libkrun");
    process.exitCode = 1;
    return;
  }
  process.env.HIVE_RUNTIME = "libkrun";

  // The commit identity defaults to the user's own git identity.
  if (!process.env.GIT_AUTHOR_NAME) {
    const name = gitConfigValue("user.name");
    const email = gitConfigValue("user.email");
    if (name && email) {
      process.env.GIT_AUTHOR_NAME = name;
      process.env.GIT_AUTHOR_EMAIL = email;
      process.env.GIT_COMMITTER_NAME = name;
      process.env.GIT_COMMITTER_EMAIL = email;
    }
  }

  // A release bundle carries its own launcher and tells us which rootfs it needs. Set these
  // before ./config.ts is first imported; the launcher/rootfs env vars win over the defaults.
  const bundleRoot = process.env.HIVE_BUNDLE_ROOT;
  if (bundleRoot) {
    process.env.HIVE_VM_BIN ||= join(bundleRoot, "libexec/hive-vm");
    try {
      const rver = readFileSync(join(bundleRoot, "ROOTFS_VERSION"), "utf8").trim();
      // rootfsBootPath is a folder on Linux but rootfs/<rver>/rootfs.img on macOS; use the
      // release layout instead of assuming a folder (the installed image would otherwise be a
      // directory, which the launcher refuses).
      const { rootfsBootPath } = await import("./release.js");
      process.env.HIVE_ROOTFS ||= rootfsBootPath(rver);
    } catch {
      // No ROOTFS_VERSION in the bundle: leave HIVE_ROOTFS to its source default.
    }
  }

  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    const { currentVersion } = await import("./release.js");
    process.stdout.write(`hive ${versionLabel(currentVersion())}\n`);
    return;
  }

  switch (cmd) {
    case "run":
      process.exitCode = await cmdRun(rest);
      return;
    case "new":
      process.exitCode = await cmdNew(rest);
      return;
    case "log":
      process.exitCode = await cmdLog(rest);
      return;
    case "continue":
      process.exitCode = await cmdContinue(rest);
      return;
    case "diff":
      process.exitCode = await cmdDiff(rest);
      return;
    case "apply":
      process.exitCode = await cmdApply(rest);
      return;
    case "export":
      process.exitCode = await cmdExport(rest);
      return;
    case "push":
      process.exitCode = await cmdPush(rest);
      return;
    case "list":
      process.exitCode = await cmdList(rest);
      return;
    case "clean":
      process.exitCode = await cmdClean(rest);
      return;
    case "keep":
      process.exitCode = await cmdKeep(rest);
      return;
    case "keys":
      process.exitCode = await cmdKeys(rest);
      return;
    case "login":
      process.exitCode = await cmdLogin(rest);
      return;
    case "serve":
      process.exitCode = await cmdServe(rest);
      return;
    case "service":
      process.exitCode = await cmdService(rest);
      return;
    case "uninstall":
      process.exitCode = await cmdUninstall(rest);
      return;
    case "setup":
      process.exitCode = await cmdSetup(rest);
      return;
    case "doctor":
      process.exitCode = await cmdDoctor(rest);
      return;
    case "update":
      process.exitCode = await cmdUpdate(rest);
      return;
    default:
      process.stderr.write(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  // git's own messages carry the agent's commit subjects, so this is another way its bytes reach
  // a terminal; filter it the same way, and only when a person is watching.
  console.error(forTerminal(`hive: ${err instanceof Error ? err.message : String(err)}`, process.stderr));
  process.exitCode = 1;
});
