#!/usr/bin/env node
/**
 * `hive` — run pi on the current git repo in a throwaway libkrun microVM, then export/apply the
 * agent's commits. Text crosses the VM boundary only through files: io/ in, out/ (patches) back.
 *
 * Config/sandbox/runs/git are imported dynamically after the environment is prepared, so that
 * HIVE_DOTENV_PATH and HIVE_RUNTIME are in place before ./config.ts reads them.
 */
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const USAGE = `hive run [-m model] [-p provider] [-t thinking] [--json] [--repo <owner/name|url> [--ref <branch>]] "<prompt>"
hive run [-m model] [-p provider] [-t thinking] [--json] [--repo <owner/name|url> [--ref <branch>]] -f <prompt-file>
hive log [run] [--json]
hive diff [run] [--stat]
hive apply [run] [--branch <name>]
hive push [run] [--branch <name>] [--remote <name>] [--pr [--base <branch>]]
hive list
hive clean <run> | --all
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeEvent(json: boolean, render: (e: any) => string | undefined, e: any): void {
  if (json) {
    process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }
  const line = render(e);
  if (line !== undefined) process.stdout.write(line + "\n");
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
    },
  });
  const { normalizeCliRepo, repoTop, isDirty } = await import("./git.js");
  const { startRun, listRuns } = await import("./runs.js");
  const { libkrunAvailable, checkSandbox } = await import("./sandbox.js");
  const { renderEvent } = await import("./render.js");

  const prompt = values.file ? readFileSync(values.file, "utf8") : (positionals[0] ?? "");
  if (!prompt.trim()) throw new Error("a prompt is required");
  if (values.ref !== undefined && values.repo === undefined) throw new Error("--ref needs --repo");

  let repo: string | undefined;
  let remote: { url: string; name: string; ref?: string } | undefined;
  if (values.repo !== undefined) {
    remote = { ...normalizeCliRepo(values.repo), ref: values.ref };
  } else {
    repo = await repoTop(process.cwd());
  }

  if (!libkrunAvailable()) {
    console.error("hive: can't start a VM:");
    for (const problem of checkSandbox()) console.error(problem);
    console.error(
      "hive needs /dev/kvm, pasta, libkrun, the launcher (npm run build:vm) and the rootfs (npm run build:rootfs)",
    );
    return 1;
  }

  if (repo !== undefined && (await isDirty(repo))) {
    console.error("hive: uncommitted changes are not included; the agent works on HEAD");
  }

  const abort = new AbortController();
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error("hive: stopping…");
    abort.abort();
  };
  process.on("SIGINT", onSigint);

  // startRun() reports the run only when it finishes, so watch the runs dir for the new one.
  const before = new Set(listRuns().map((r) => r.dir));
  const announce = setInterval(() => {
    const fresh = listRuns().find((r) => !before.has(r.dir));
    if (fresh) {
      console.error(`hive: run ${fresh.name}`);
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
      signal: abort.signal,
      onEvent: (e) => writeEvent(!!values.json, renderEvent, e),
    });
  } finally {
    clearInterval(announce);
    process.removeListener("SIGINT", onSigint);
  }

  const dir = run.dir;
  const meta = run.meta;

  const name = basename(dir);
  if (meta.status === "done") {
    console.error(
      `hive: done, ${meta.commits} commit(s), $${meta.usage.cost.toFixed(4)}, ${meta.usage.input} in / ${meta.usage.output} out tokens`,
    );
    if (meta.commits === 0) {
      console.error("hive: no changes");
      return 0;
    }
    console.error(`hive diff ${name}`);
    if (meta.source !== "remote") console.error(`hive apply ${name}`);
    console.error(`hive push ${name}`);
    return 0;
  }
  if (meta.status === "aborted") {
    console.error("hive: aborted");
    return 130;
  }
  console.error(`hive: failed: ${meta.error}`);
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
    console.error(`hive: ${readMeta(dir).status}`);
    return 0;
  }
  while (isLive(readMeta(dir))) await sleep(500);
  follower.stop();
  console.error(`hive: ${readMeta(dir).status}`);
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
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
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

async function cmdPush(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      branch: { type: "string" },
      remote: { type: "string" },
      pr: { type: "boolean" },
      base: { type: "string" },
    },
  });
  if (values.base !== undefined && !values.pr) throw new Error("--base needs --pr");
  const { openPr, pushRun, resolveRun } = await import("./runs.js");
  const dir = resolveRun(positionals[0]);
  const result = await pushRun(dir, { branch: values.branch, remote: values.remote, requireGithub: !!values.pr });
  process.stdout.write(`hive: pushed ${result.commits} commit(s) to ${result.branch} on ${result.url}\n`);
  if (values.pr) process.stdout.write((await openPr(dir, { base: values.base })) + "\n");
  return 0;
}

async function cmdList(args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true });
  const { listRuns } = await import("./runs.js");
  const runs = listRuns();
  if (runs.length === 0) {
    process.stdout.write("no runs\n");
    return 0;
  }
  for (const run of runs) {
    process.stdout.write(
      `${run.name}  ${run.meta.status}  ${run.meta.commits} commit(s)  $${run.meta.usage.cost.toFixed(4)}  ${run.meta.repo}\n`,
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
      cleanRun(run.dir);
      process.stdout.write(`hive: cleaned ${run.name}\n`);
    }
    return 0;
  }
  if (positionals.length === 0) throw new Error("clean needs a run name or --all");
  const dir = resolveRun(positionals[0]);
  cleanRun(dir);
  process.stdout.write(`hive: cleaned ${basename(dir)}\n`);
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

  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  switch (cmd) {
    case "run":
      process.exitCode = await cmdRun(rest);
      return;
    case "log":
      process.exitCode = await cmdLog(rest);
      return;
    case "diff":
      process.exitCode = await cmdDiff(rest);
      return;
    case "apply":
      process.exitCode = await cmdApply(rest);
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
    default:
      process.stderr.write(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`hive: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
