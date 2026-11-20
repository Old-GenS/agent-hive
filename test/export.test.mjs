// Exporting a finished run's result: a zip of the project files or a git bundle of its commits.
// Export is built on the host from the run's exported patches, applied to a fresh clone of the
// trusted source; it never touches the agent-controlled work/ copy. The runs dir is a fresh temp
// dir set before importing any dist module, because config.ts reads it at import time.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const runsDir = mkdtempSync(join(tmpdir(), "hive-export-test-"));
process.env.HIVE_RUNS_DIR = runsDir;
process.env.HIVE_RUNTIME = "libkrun";
process.env.HIVE_DOTENV_PATH = join(runsDir, "missing.env");
process.env.HIVE_KEYS_FILE = join(runsDir, "missing-keys");
process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";

const { exportRun } = await import("../dist/runs.js");

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@t"];

function git(cwd, ...args) {
  return execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" });
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeMeta(dir, meta) {
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      repo: "https://github.com/me/demo.git",
      source: "remote",
      status: "done",
      commits: 1,
      createdAt: 1,
      prompt: "p",
      provider: "x",
      model: "y",
      thinking: "low",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      pid: 1,
      ...meta,
    }),
  );
}

/**
 * A fake run folder: origin/ with one base commit (README.md), out/ with one patch that adds
 * hello.txt, and meta.json pointing at the base. No work/ folder: export must not need it.
 */
function makeRun(name = "demo-20260101-000000") {
  const dir = join(runsDir, name);
  const origin = join(dir, "origin");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "README.md"), "base\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const base = git(origin, "rev-parse", "HEAD").trim();

  const scratch = tempDir("hive-export-scratch-");
  const clone = join(scratch, "clone");
  git(scratch, "clone", "-q", origin, "clone");
  writeFileSync(join(clone, "hello.txt"), "hello\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "add hello");
  mkdirSync(join(dir, "out"), { recursive: true });
  git(clone, "format-patch", "-q", "-o", join(dir, "out"), `${base}..HEAD`);

  writeMeta(dir, { base });
  return { dir, name };
}

test("exportRun makes a zip of the project files from origin and the patches", async () => {
  const { dir, name } = makeRun();
  const repoName = name.replace(/-\d{8}-\d{6}$/, "");
  const out = join(tempDir("hive-export-out-"), "result.zip");

  const result = await exportRun(dir, "zip", out);
  assert.equal(result.path, out);
  assert.equal(result.commits, 1);
  assert.ok(existsSync(out), "the zip exists");

  // A zip keeps its entry names in the central directory (and local headers) as plain bytes.
  const bytes = readFileSync(out);
  assert.ok(bytes.includes(Buffer.from(`${repoName}/hello.txt`)), "zip lists hello.txt under the project name");
  assert.ok(bytes.includes(Buffer.from(`${repoName}/README.md`)), "zip lists README.md under the project name");
  assert.ok(!bytes.includes(Buffer.from("work/")), "zip does not come from work/");
});

test("exportRun makes a git bundle whose history holds the run's commits", async () => {
  const { dir, name } = makeRun("bundle-20260101-000000");
  const out = join(tempDir("hive-export-out-"), "result.bundle");

  const result = await exportRun(dir, "bundle", out);
  assert.equal(result.commits, 1);

  const clone = join(tempDir("hive-export-clone-"), "clone");
  git(tmpdir(), "clone", "-q", out, clone);
  const subjects = git(clone, "log", "--format=%s").trim().split("\n");
  assert.ok(subjects.includes("add hello"), `bundle history has the patch subject: ${subjects}`);
  assert.ok(subjects.includes("base"), "bundle history has the base commit");
  assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD").trim(), `hive/${name}`);
  assert.ok(existsSync(join(clone, "hello.txt")));
});

test("exportRun refuses a run with no patches", async () => {
  const dir = join(runsDir, "empty-20260101-000000");
  mkdirSync(dir, { recursive: true });
  writeMeta(dir, { base: "0".repeat(40) });
  const out = join(tempDir("hive-export-out-"), "result.zip");
  await assert.rejects(() => exportRun(dir, "zip", out), /no commits to export/);
});

test("exportRun refuses a run that is still going", async () => {
  const dir = join(runsDir, "live-20260101-000000");
  mkdirSync(dir, { recursive: true });
  writeMeta(dir, { base: "0".repeat(40), status: "running", pid: process.pid });
  const out = join(tempDir("hive-export-out-"), "result.zip");
  await assert.rejects(() => exportRun(dir, "zip", out), /run is still going/);
});

test("exportRun never runs code from the run's work/ folder", async () => {
  const { dir } = makeRun("hooked-20260101-000000");
  const marker = join(tempDir("hive-export-marker-"), "marker");
  const hooks = join(dir, "work", ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "post-checkout");
  writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(hook, 0o755);

  const out = join(tempDir("hive-export-out-"), "result.zip");
  await exportRun(dir, "zip", out);
  assert.equal(existsSync(marker), false, "the agent's post-checkout hook was not run");
});
