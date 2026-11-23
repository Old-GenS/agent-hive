// `hive uninstall`: the plan, the path guard, a dry run, the real removal, the source-checkout
// case and the CLI's non-interactive refusal. Every HOME/XDG/runs/keys folder is a temp dir set
// before the dist modules are imported, and HIVE_SERVICE_DIR points at an empty temp dir so the
// service is never touched. No real home folder is ever read or removed.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "hive-uninstall-"));
const home = join(root, "home");
const xdgData = join(root, "xdg-data");
const xdgCache = join(root, "xdg-cache");
const xdgConfig = join(root, "xdg-config");
const serviceDir = join(root, "service");
const dataDir = join(xdgData, "agent-hive");
const versionsDir = join(dataDir, "versions");
const currentLink = join(dataDir, "current");
const rootfsDir = join(dataDir, "rootfs");
const cacheRoot = join(xdgCache, "agent-hive");
const runsDir = join(cacheRoot, "runs");
const runDir = join(runsDir, "owner-repo-20240101-000000");
const keysFile = join(xdgConfig, "agent-hive/env");
const configDir = join(xdgConfig, "agent-hive");
const binLink = join(home, ".local/bin/hive");
const profile = join(home, ".profile");
const PROFILE_LINE = 'export PATH="$HOME/.local/bin:$PATH"  # added by agent-hive';

process.env.HOME = home;
process.env.XDG_DATA_HOME = xdgData;
process.env.XDG_CACHE_HOME = xdgCache;
process.env.XDG_CONFIG_HOME = xdgConfig;
process.env.HIVE_RUNS_DIR = runsDir;
process.env.HIVE_KEYS_FILE = keysFile;
process.env.HIVE_SERVICE_DIR = serviceDir;
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
delete process.env.HIVE_VM_CACHE;

const { uninstallPlan, runUninstall, uninstallEntries, assertRemovable, sizeLabel, pathBytes } = await import(
  "../dist/uninstall.js"
);
const { servicePaths } = await import("../dist/service.js");
// systemd on Linux, a launchd agent on macOS: the plan looks for this file, whatever it is called.
const serviceFile = servicePaths().file;

function bytes(n) {
  return Buffer.alloc(n);
}

/** The installed-release + runs + keys + cache + profile fixture every test starts from. */
function setup() {
  rmSync(root, { recursive: true, force: true });
  for (const dir of [
    home,
    join(home, ".local", "bin"),
    join(versionsDir, "1.0.0", "bin"),
    join(rootfsDir, "0123456789ab"),
    cacheRoot,
    join(cacheRoot, "vm-cache", "repos", "key"),
    runDir,
    serviceDir,
    configDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(versionsDir, "1.0.0", "VERSION"), "1.0.0\n");
  writeFileSync(join(versionsDir, "1.0.0", "bin", "hive"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync(join(versionsDir, "1.0.0"), currentLink);
  writeFileSync(join(rootfsDir, "0123456789ab", ".complete"), "");
  writeFileSync(join(rootfsDir, "0123456789ab", "blob"), bytes(4096));
  writeFileSync(join(dataDir, "channel"), "stable\n");
  symlinkSync(join(currentLink, "bin", "hive"), binLink);
  writeFileSync(join(cacheRoot, "update-check.json"), JSON.stringify({ checkedAt: 1, latest: "1.0.0" }));
  writeFileSync(join(cacheRoot, "vm-cache", "repos", "key", "npm"), "cache\n");
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      repo: "/tmp/owner/repo",
      source: "local",
      base: "abc",
      provider: "deepseek",
      model: "m",
      thinking: "low",
      prompt: "p",
      status: "done",
      pid: 1,
      commits: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      createdAt: Date.now() - 60_000,
      finishedAt: Date.now() - 30_000,
    }),
  );
  mkdirSync(join(runDir, "work"), { recursive: true });
  writeFileSync(join(runDir, "work", "file.txt"), "run data\n");
  writeFileSync(keysFile, "DEFAULT_PROVIDER=deepseek\n", { mode: 0o600 });
  writeFileSync(
    profile,
    ["# my profile", "export FOO=bar", PROFILE_LINE, "alias x=y", ""].join("\n"),
  );
}

/** A service file in the temp service dir, so the plan reports the service as installed. */
function addServiceFile() {
  writeFileSync(serviceFile, "[Unit]\n");
}

setup();
after(() => rmSync(root, { recursive: true, force: true }));

test("uninstallPlan keeps runs and config by default, and lists app, bin, cache and PATH lines", () => {
  const plan = uninstallPlan({ keepRuns: true, keepConfig: true });
  assert.equal(plan.app, dataDir);
  assert.equal(plan.bin, binLink);
  assert.equal(plan.sourceInstall, false);
  assert.equal(plan.runs, undefined);
  assert.equal(plan.config, undefined);
  assert.equal(plan.runsCount, 1);

  assert.deepEqual([...plan.cache].sort(), [
    join(cacheRoot, "update-check.json"),
    join(cacheRoot, "vm-cache"),
  ]);
  assert.ok(!plan.cache.includes(runsDir), "the runs folder is never in the cache list");

  assert.equal(plan.pathLines.length, 1);
  assert.equal(plan.pathLines[0].file, profile);
  assert.deepEqual(plan.pathLines[0].lines, [PROFILE_LINE]);

  assert.equal(typeof plan.sizes[dataDir], "number");
  assert.ok(plan.sizes[dataDir] > 0);
  assert.equal(typeof plan.sizes[binLink], "number");
  assert.equal(plan.sizes[runsDir] > 0, true);
  assert.equal(plan.sizes[configDir] > 0, true);
  assert.equal(plan.service, false);

  const entries = uninstallEntries(plan);
  const app = entries.find((entry) => entry.kind === "app");
  assert.equal(app.label, "app and VM filesystem");
  assert.equal(app.exists, true);
  assert.equal(app.bytes, plan.sizes[dataDir]);
});

test("uninstallPlan lists runs and config when they are not kept", () => {
  const plan = uninstallPlan({ keepRuns: false, keepConfig: false });
  assert.equal(plan.runs, runsDir);
  assert.equal(plan.config, configDir);
  assert.ok(!plan.cache.includes(runsDir));
  const kinds = uninstallEntries(plan).map((entry) => entry.kind);
  assert.deepEqual(kinds, ["app", "bin", "cache", "cache", "runs", "config"]);
});

test("the path guard refuses HOME itself, /, and paths outside the hive folders", () => {
  assert.throws(() => assertRemovable(home), /refusing/);
  assert.throws(() => assertRemovable("/"), /refusing/);
  assert.throws(() => assertRemovable("/etc/passwd"), /refusing/);
  assert.throws(() => assertRemovable("relative/path"), /refusing/);
  assert.doesNotThrow(() => assertRemovable(dataDir));
  assert.doesNotThrow(() => assertRemovable(profile));
});

test("a dry run reports the actions and changes nothing", () => {
  const plan = uninstallPlan({ keepRuns: true, keepConfig: true });
  const before = readFileSync(profile, "utf8");
  const lines = runUninstall(plan, { dryRun: true });
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => line.startsWith("would ")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes(`remove ${dataDir}`)), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes('"added by agent-hive" line')), lines.join("\n"));
  assert.ok(existsSync(dataDir));
  assert.ok(existsSync(binLink));
  assert.ok(existsSync(runDir));
  assert.ok(existsSync(keysFile));
  assert.equal(readFileSync(profile, "utf8"), before);
});

test("a service file is reported in the plan and only reported by a dry run", () => {
  addServiceFile();
  const plan = uninstallPlan({ keepRuns: true, keepConfig: true });
  assert.equal(plan.service, true);
  const lines = runUninstall(plan, { dryRun: true });
  assert.ok(lines.some((line) => /background service/.test(line)));
  assert.ok(existsSync(serviceFile), "a dry run leaves the service file");
  rmSync(serviceFile);
  assert.equal(uninstallPlan({ keepRuns: true, keepConfig: true }).service, false);
});

test("a bin symlink pointing outside the data dir is left alone and marks a source install", () => {
  const checkout = join(root, "checkout", "dist", "cli.js");
  mkdirSync(dirname(checkout), { recursive: true });
  writeFileSync(checkout, "#!/usr/bin/env node\n");
  rmSync(binLink, { force: true });
  symlinkSync(checkout, binLink);
  try {
    const plan = uninstallPlan({ keepRuns: true, keepConfig: true });
    assert.equal(plan.sourceInstall, true);
    assert.equal(plan.bin, undefined);
    assert.ok(!uninstallEntries(plan).some((entry) => entry.kind === "bin"));
    assert.ok(existsSync(checkout));
  } finally {
    rmSync(binLink, { force: true });
    symlinkSync(join(currentLink, "bin", "hive"), binLink);
  }
});

test("a live run makes the plan and the uninstall throw", () => {
  const plan = uninstallPlan({ keepRuns: true, keepConfig: true });
  const liveDir = join(runsDir, "live-run");
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(
    join(liveDir, "meta.json"),
    JSON.stringify({
      repo: "/tmp/owner/repo",
      source: "local",
      base: "abc",
      provider: "deepseek",
      model: "m",
      thinking: "low",
      prompt: "p",
      status: "running",
      pid: process.pid,
      commits: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      createdAt: Date.now(),
    }),
  );
  try {
    assert.throws(
      () => uninstallPlan({ keepRuns: true, keepConfig: true }),
      /a run is still going \(live-run\); stop it first/,
    );
    assert.throws(() => runUninstall(plan), /a run is still going \(live-run\); stop it first/);
  } finally {
    rmSync(liveDir, { recursive: true, force: true });
  }
});

test("CLI: without a TTY and without --yes it prints the plan and exits 1", () => {
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    HIVE_RUNS_DIR: runsDir,
    HIVE_KEYS_FILE: keysFile,
    HIVE_SERVICE_DIR: serviceDir,
    HIVE_DOTENV_PATH: join(root, "missing.env"),
    NO_COLOR: "1",
  };
  const result = spawnSync(process.execPath, ["dist/cli.js", "uninstall"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /hive: this will remove:/);
  assert.match(result.stdout, /app and VM filesystem/);
  assert.ok(result.stdout.includes(dataDir), result.stdout);
  assert.match(result.stderr, /hive: run hive uninstall --yes to remove it \(add --all to also remove runs and keys\)/);
  assert.ok(existsSync(dataDir), "nothing was removed");
});

test("CLI: --yes --dry-run exits 0 and changes nothing", () => {
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    HIVE_RUNS_DIR: runsDir,
    HIVE_KEYS_FILE: keysFile,
    HIVE_SERVICE_DIR: serviceDir,
    HIVE_DOTENV_PATH: join(root, "missing.env"),
    NO_COLOR: "1",
  };
  const result = spawnSync(process.execPath, ["dist/cli.js", "uninstall", "--yes", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /hive: would remove /);
  assert.ok(existsSync(dataDir));
  assert.ok(existsSync(join(runDir, "work", "file.txt")));
  assert.ok(existsSync(keysFile));
});

test("the help output mentions hive uninstall", () => {
  const help = spawnSync(process.execPath, ["dist/cli.js", "--help"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^hive uninstall \[--yes\] \[--all\] \[--dry-run\]$/m);
});

test("runUninstall removes exactly the plan, keeps runs and config, and rewrites the profile", () => {
  const plan = uninstallPlan({ keepRuns: true, keepConfig: true });
  const lines = runUninstall(plan);

  assert.ok(lines.some((line) => line === `remove ${dataDir} (${sizeLabel(plan.sizes[dataDir])})`));
  assert.ok(!lines.some((line) => line.startsWith("would ")));
  assert.equal(existsSync(dataDir), false, "the app data dir is gone");
  assert.equal(existsSync(binLink), false, "the command symlink is gone");
  assert.equal(existsSync(join(cacheRoot, "update-check.json")), false);
  assert.equal(existsSync(join(cacheRoot, "vm-cache")), false);
  assert.equal(existsSync(runsDir), true, "runs are kept");
  assert.equal(existsSync(join(runDir, "work", "file.txt")), true, "run data is kept");
  assert.equal(existsSync(configDir), true, "config is kept");
  assert.equal(existsSync(keysFile), true, "keys are kept");

  const text = readFileSync(profile, "utf8");
  assert.ok(!text.includes("added by agent-hive"), text);
  assert.equal(text, ["# my profile", "export FOO=bar", "alias x=y", ""].join("\n"));

  // A second run with everything unkept removes the runs folder and the config folder too.
  const full = uninstallPlan({ keepRuns: false, keepConfig: false });
  const more = runUninstall(full);
  assert.ok(more.some((line) => line.startsWith(`remove ${runsDir}`)), more.join("\n"));
  assert.ok(more.some((line) => line.startsWith(`remove ${configDir}`)), more.join("\n"));
  assert.equal(existsSync(runsDir), false);
  assert.equal(existsSync(configDir), false);
});

test("uninstallPlan finds the zsh PATH line as well as the bash one", () => {
  setup();
  const zprofile = join(home, ".zprofile");
  writeFileSync(zprofile, PROFILE_LINE + "\n");
  try {
    const plan = uninstallPlan({ keepRuns: true, keepConfig: true });
    assert.deepEqual(plan.pathLines.map((entry) => entry.file), [profile, zprofile]);
  } finally {
    rmSync(zprofile, { force: true });
  }
});

test("sizeLabel shows human sizes", () => {
  assert.equal(sizeLabel(undefined), "");
  assert.equal(sizeLabel(0), "0 B");
  assert.equal(sizeLabel(1024 ** 2), "1.0 MB");
  assert.equal(sizeLabel(712 * 1024 ** 2), "712 MB");
  assert.equal(sizeLabel(1.5 * 1024 ** 3), "1.5 GB");
  assert.equal(typeof pathBytes(profile), "number");
});
