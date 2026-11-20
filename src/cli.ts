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
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
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
hive keys [list]
hive keys add <provider> [--no-test]
hive keys test [provider]
hive keys remove <provider>
hive keys default <provider>
hive setup
hive doctor
hive update [--check | --rollback]
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
  const { bundleRoot, updateNotice } = await import("./release.js");

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
      isDefault: id === defaultProvider ? " (default)" : "",
    };
  });
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const keyWidth = Math.max(...rows.map((r) => r.key.length));
  const sourceWidth = Math.max(...rows.map((r) => r.source.length));
  for (const row of rows) {
    process.stdout.write(
      `${row.label.padEnd(labelWidth)}  ${row.key.padEnd(keyWidth)}  ${row.source.padEnd(sourceWidth)}  ${row.model}${row.isDefault}\n`,
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
  const provider = positionals[0];
  if (!provider) throw new Error("keys add needs a provider");
  const { PROVIDERS } = await import("./config.js");
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
  const provider = positionals[0];
  if (!provider) throw new Error("keys default needs a provider");
  const { PROVIDERS, providerKey } = await import("./config.js");
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

function kvmState(): "ok" | "missing" | "no access" {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return "ok";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "no access";
  }
}

/** Path of a command on PATH, or undefined. */
function commandPath(bin: string): string | undefined {
  try {
    const path = execFileSync("sh", ["-c", `command -v ${bin}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

async function cmdDoctor(args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true });
  const { config, providerInfo } = await import("./config.js");
  const { libkrunAvailable } = await import("./sandbox.js");
  const { currentVersion } = await import("./release.js");

  let allOk = true;
  const lines: string[] = [`hive ${currentVersion() ?? "dev (from source)"}`];

  const kvm = kvmState();
  lines.push(`/dev/kvm: ${kvm}`);
  if (kvm !== "ok") allOk = false;

  const libkrun = config.sandbox.libkrun;
  let libkrunOk = false;
  if (existsSync(config.sandbox.vmBin)) {
    try {
      execFileSync(config.sandbox.vmBin, ["--check"], {
        env: { ...process.env, HIVE_LIBKRUN: libkrun },
        stdio: "ignore",
      });
      libkrunOk = true;
    } catch {
      libkrunOk = false;
    }
  }
  lines.push(
    libkrunOk
      ? `libkrun: ok (${libkrun})`
      : "libkrun: not found — install your distro's libkrun package (Fedora: sudo dnf install libkrun)",
  );
  if (!libkrunOk) allOk = false;

  const pasta = commandPath("pasta");
  lines.push(pasta ? `pasta: ok (${pasta})` : "pasta: not found — install passt (Fedora: sudo dnf install passt)");
  if (!pasta) allOk = false;

  const launcherOk = existsSync(config.sandbox.vmBin);
  lines.push(
    launcherOk ? `launcher: ok (${config.sandbox.vmBin})` : `launcher: missing (${config.sandbox.vmBin})`,
  );
  if (!launcherOk) allOk = false;

  let rootfsOk = false;
  let rootfsPath = config.sandbox.rootfs;
  try {
    rootfsPath = realpathSync(config.sandbox.rootfs);
    rootfsOk = existsSync(join(rootfsPath, "usr/local/bin/hive-vm-init"));
  } catch {
    rootfsOk = false;
  }
  lines.push(rootfsOk ? `rootfs: ok (${rootfsPath})` : `rootfs: missing (${config.sandbox.rootfs}) — run hive setup`);
  if (!rootfsOk) allOk = false;

  const isolationOk = libkrunAvailable();
  lines.push(`isolation: ${isolationOk ? "microvm (system libkrun)" : "unavailable"}`);
  if (!isolationOk) allOk = false;

  const providers = providerInfo();
  const def = providers.default;
  if (def.provider !== null) {
    lines.push(
      def.providerSource === "DEFAULT_PROVIDER"
        ? `provider: ${def.provider} (DEFAULT_PROVIDER)`
        : `provider: ${def.provider} (first provider with a key; set DEFAULT_PROVIDER to choose)`,
    );
  } else if (process.env.DEFAULT_PROVIDER) {
    lines.push(
      `provider: unknown "${process.env.DEFAULT_PROVIDER}" (DEFAULT_PROVIDER); supported: deepseek, zai, openrouter, anthropic, openai`,
    );
  } else {
    lines.push("provider: none (no API key set)");
  }
  if (def.model !== null) {
    lines.push(
      def.modelSource === "DEFAULT_MODEL"
        ? `model: ${def.model} (DEFAULT_MODEL)`
        : `model: ${def.model} (${def.provider}'s default)`,
    );
  }
  lines.push(`thinking: ${def.thinking}`);

  process.stdout.write(lines.join("\n") + "\n");
  return allOk ? 0 : 1;
}

async function cmdSetup(args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true });
  const { bundleRoot, setupRootfs } = await import("./release.js");
  if (bundleRoot()) {
    const path = await setupRootfs();
    process.stdout.write(`hive: VM filesystem ready: ${path}\n`);
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
    },
  });
  const { activate, bundleRoot, compareVersions, currentVersion, fetchRelease, installRelease, prune, rollback } =
    await import("./release.js");
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

  const rel = await fetchRelease();
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
  await installRelease(rel);
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
      const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
      process.env.HIVE_ROOTFS ||= join(dataHome, "agent-hive/rootfs", rver);
    } catch {
      // No ROOTFS_VERSION in the bundle: leave HIVE_ROOTFS to its source default.
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
    case "keys":
      process.exitCode = await cmdKeys(rest);
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
  console.error(`hive: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
