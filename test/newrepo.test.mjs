// New-project runs: repo-name validation, the empty-repo setup, and the `gh`-backed repository
// creation. A fake `gh` script is used, so no real GitHub access ever happens.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ghDir = mkdtempSync(join(tmpdir(), "hive-newrepo-"));
const ghLog = join(ghDir, "gh.log");
const fakeGh = join(ghDir, "gh");
writeFileSync(
  fakeGh,
  [
    "#!/bin/sh",
    'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
    'if [ "$1" = api ]; then echo me; exit 0; fi',
    'if [ "$1" = repo ] && [ "$3" = me/taken ]; then echo "name already exists" >&2; exit 1; fi',
    'if [ "$1" = repo ]; then echo "https://github.com/$3"; exit 0; fi',
    "exit 1",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(ghLog, "");

process.env.HIVE_DOTENV_PATH = join(ghDir, "missing.env");
process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";
process.env.GH_BIN = fakeGh;
process.env.FAKE_GH_LOG = ghLog;
process.env.DEEPSEEK_API_KEY = "sk-test";
delete process.env.HIVE_GIT_PROTOCOL;

const { createGithubRepo, githubLogin, prepareNewRepo, validateRepoName } = await import("../dist/git.js");
const { createTask } = await import("../dist/tasks.js");

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
}

function ghLogLines() {
  return readFileSync(ghLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

test("validateRepoName accepts safe names and rejects the rest", () => {
  assert.equal(validateRepoName("my-app"), "my-app");
  assert.equal(validateRepoName("a.b_c"), "a.b_c");
  assert.equal(validateRepoName("  spaced  "), "spaced");
  for (const bad of ["bad name", "-x", ".x", "x.git", "..", "a/b", "a".repeat(101)]) {
    assert.throws(() => validateRepoName(bad), /Project name may only use letters, digits, '-', '_' and '.' \(max 100\)/);
  }
});

test("prepareNewRepo makes an empty main repo and a work copy of it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-newrepo-dir-"));
  const base = await prepareNewRepo(dir);

  assert.ok(statSync(join(dir, "origin")).isDirectory(), "origin/ exists");
  assert.ok(statSync(join(dir, "work")).isDirectory(), "work/ exists");
  assert.equal(git(join(dir, "work"), "log", "--format=%s").trim(), "Initial commit");
  assert.equal(git(join(dir, "work"), "remote").trim(), "");
  assert.equal(base, git(join(dir, "origin"), "rev-parse", "HEAD").trim());
});

test("createGithubRepo creates a private repo and returns owner/name", async () => {
  writeFileSync(ghLog, "");
  const full = await createGithubRepo("demo", true);
  assert.equal(full, "me/demo");
  const lines = ghLogLines();
  assert.equal(lines[lines.length - 1], "repo create me/demo --private --description Created by agent-hive");
});

test("createGithubRepo passes --public for a public repo", async () => {
  writeFileSync(ghLog, "");
  const full = await createGithubRepo("demo", false);
  assert.equal(full, "me/demo");
  const lines = ghLogLines();
  assert.equal(lines[lines.length - 1], "repo create me/demo --public --description Created by agent-hive");
});

test("createGithubRepo reports gh's failure", async () => {
  await assert.rejects(
    createGithubRepo("taken", true),
    /Couldn't create the GitHub repository me\/taken: name already exists/,
  );
});

test("githubLogin returns the gh account", async () => {
  assert.equal(await githubLogin(), "me");
});

test("createTask refuses repo and newRepo together", () => {
  assert.throws(
    () => createTask({ prompt: "x", repo: "a/b", newRepo: { name: "c" } }),
    /repo or newRepo/,
  );
});
