// A VM step can plant symlinks in the run's VM-writable folders (io/, io-export/, out/) to make the
// host read a host file (into the next system prompt or as a patch) or write one. The host code
// must never follow them. No VM is booted here: only the host pieces ran between steps.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts reads these at import time, so set them before importing any dist module.
const runsDir = mkdtempSync(join(tmpdir(), "hive-symlink-escape-"));
process.env.HIVE_RUNS_DIR = runsDir;
process.env.HIVE_RUNTIME = "libkrun";
process.env.HIVE_DOTENV_PATH = join(runsDir, "missing.env");
process.env.HIVE_KEYS_FILE = join(runsDir, "missing-keys");
process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";

const { exportRun, patchFiles, prepareStepFiles, slimStepLog } = await import("../dist/runs.js");

const SECRET = "HOST-ONLY-SECRET-e7c1a9";
const IDENT = ["-c", "user.name=t", "-c", "user.email=t@t"];

function git(cwd, ...args) {
  return execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" });
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A finished run folder: origin/ with a base commit and out/ with one real patch. */
function makeFinishedRun(name) {
  const dir = join(runsDir, name);
  const origin = join(dir, "origin");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "README.md"), "base\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const base = git(origin, "rev-parse", "HEAD").trim();

  const scratch = tempDir("hive-symlink-scratch-");
  const clone = join(scratch, "clone");
  git(scratch, "clone", "-q", origin, clone);
  writeFileSync(join(clone, "hello.txt"), "hello\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "add hello");
  mkdirSync(join(dir, "out"), { recursive: true });
  git(clone, "format-patch", "-q", "-o", join(dir, "out"), `${base}..HEAD`);

  const meta = {
    repo: "https://github.com/me/demo.git",
    source: "remote",
    base,
    status: "done",
    commits: 1,
    createdAt: 1,
    prompt: "p",
    provider: "deepseek",
    model: "m",
    thinking: "low",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    pid: 1,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return { dir, meta };
}

/** No regular file under io/ may carry the host secret; symlinks stay links. */
function assertNoLeak(dir, secretPath) {
  const ioDir = join(dir, "io");
  for (const name of readdirSync(ioDir)) {
    const path = join(ioDir, name);
    const stat = lstatSync(path);
    if (stat.isFile()) {
      assert.ok(!readFileSync(path, "utf8").includes(SECRET), `io/${name} leaked the host file`);
    }
  }
  assert.equal(readFileSync(secretPath, "utf8"), SECRET, "the host file was not written");
}

test("host steps never follow symlinks planted in io/ or out/", async () => {
  const { dir, meta } = makeFinishedRun("escape-20260101-000000");
  const ioDir = join(dir, "io");
  mkdirSync(ioDir, { recursive: true });
  const secretPath = join(runsDir, "secret-host-file");
  writeFileSync(secretPath, SECRET);

  // Exactly what a VM step can leave behind: links from names the host reads or writes between
  // steps to a host file outside every mounted folder.
  for (const name of ["system.md", "prompt.md", "system-base.md", "events.jsonl", "stderr.log"]) {
    symlinkSync(secretPath, join(ioDir, name));
  }
  symlinkSync(secretPath, join(dir, "out", "9999-planted.patch"));

  // Between two steps: write the next step's prompts and slim the finished step's event log.
  prepareStepFiles(dir, meta, "Do the task");
  slimStepLog(dir);

  // The prompts are fresh regular files, not links to the secret.
  for (const name of ["system.md", "prompt.md"]) {
    assert.equal(lstatSync(join(ioDir, name)).isFile(), true, `io/${name} is a regular file`);
    assert.ok(!readFileSync(join(ioDir, name), "utf8").includes(SECRET));
  }
  // Nothing host-only was pulled into the step: the planted io/system-base.md is left untouched
  // (never read), and no regular file under io/ leaked the secret.
  assert.equal(lstatSync(join(ioDir, "system-base.md")).isSymbolicLink(), true);
  assertNoLeak(dir, secretPath);

  // Only the real patch counts: the planted symlink is ignored and never read by host git.
  const patches = patchFiles(dir);
  assert.equal(patches.length, 1);
  assert.ok(patches[0].endsWith("0001-add-hello.patch"), patches[0]);

  const outPath = join(tempDir("hive-symlink-export-"), "result.zip");
  const result = await exportRun(dir, "zip", outPath);
  assert.equal(result.commits, 1);
  assert.ok(existsSync(outPath));
  assert.equal(readFileSync(secretPath, "utf8"), SECRET, "the host file was not read into the export");
});
