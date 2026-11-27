// CLI repo normalisation, push and PR helpers. The runs dir is a fresh temp dir set before
// importing any dist module, because config.ts reads it at import time.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runsDir = mkdtempSync(join(tmpdir(), "hive-push-test-"));
process.env.HIVE_RUNS_DIR = runsDir;
process.env.HIVE_RUNTIME = "libkrun";
delete process.env.HIVE_GIT_PROTOCOL;
process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";
// A fake host key the pre-push scan must catch (never a real one).
process.env.DEEPSEEK_API_KEY = "sk-test-host-key-1234567890abcdef";

const { normalizeCliRepo, normalizeRepo, githubSlug, gitConfigIdentity, prepareRepo } = await import("../dist/git.js");
const { applyRun, openPr, patchSubject, prArgs, pushRun } = await import("../dist/runs.js");

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@t"];

function git(cwd, ...args) {
  return execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" });
}

function gitDir(dir, ...args) {
  return execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" });
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function commitFile(dir, file, text, message) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD").trim();
}

function writeMeta(dir, meta) {
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      status: "done",
      commits: 1,
      createdAt: 1,
      prompt: "p",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      pid: 1,
      provider: "x",
      model: "y",
      thinking: "low",
      ...meta,
    }),
  );
}

test("normalizeRepo (server) uses https by default and ssh with HIVE_GIT_PROTOCOL=ssh", () => {
  assert.deepEqual(normalizeRepo("a/b"), { url: "https://github.com/a/b.git", name: "b" });
  assert.equal(normalizeRepo("git@github.com:a/b.git").url, "https://github.com/a/b.git");
  // config.ts reads HIVE_GIT_PROTOCOL at import time, so check ssh in a fresh process.
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", 'const { normalizeRepo } = await import("./dist/git.js"); console.log(normalizeRepo("a/b").url);'],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HIVE_GIT_PROTOCOL: "ssh" } },
  );
  assert.equal(out.trim(), "git@github.com:a/b.git");
});

test("normalizeCliRepo accepts owner/name and git URLs, rejects option-like strings and paths", () => {
  assert.deepEqual(normalizeCliRepo("a/b"), { url: "https://github.com/a/b.git", name: "b" });
  assert.deepEqual(normalizeCliRepo("https://gitlab.com/x/y.git/"), {
    url: "https://gitlab.com/x/y.git",
    name: "y",
  });
  assert.equal(normalizeCliRepo("git@github.com:a/b.git").name, "b");
  for (const bad of ["-x", "/tmp/repo", "b"]) {
    assert.throws(() => normalizeCliRepo(bad), /repo must be owner\/name or a git URL/);
  }
});

test("githubSlug returns owner/name for github.com URLs only", () => {
  for (const url of [
    "https://github.com/a/b",
    "https://github.com/a/b.git",
    "ssh://git@github.com/a/b.git",
    "git@github.com:a/b.git",
  ]) {
    assert.equal(githubSlug(url), "a/b", url);
  }
  assert.equal(githubSlug("https://gitlab.com/a/b.git"), undefined);
});

test("patchSubject strips the Subject prefix and the PATCH tag", () => {
  assert.equal(patchSubject("From x\nSubject: [PATCH 2/3] fix calc\n\n"), "fix calc");
  assert.equal(patchSubject("no subject here\n"), "");
});

test("prArgs builds gh pr create arguments with and without a base", () => {
  assert.deepEqual(
    prArgs({ slug: "a/b", branch: "hive/x", title: "t", body: "b" }),
    ["pr", "create", "--repo", "a/b", "--head", "hive/x", "--title", "t", "--body", "b"],
  );
  assert.deepEqual(
    prArgs({ slug: "a/b", branch: "hive/x", title: "t", body: "b", base: "main" }),
    ["pr", "create", "--repo", "a/b", "--head", "hive/x", "--title", "t", "--body", "b", "--base", "main"],
  );
});

test("gitConfigIdentity reads the repo's user.name and user.email", () => {
  const dir = tempDir("hive-ident-");
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "n");
  git(dir, "config", "user.email", "e@e");
  assert.deepEqual(gitConfigIdentity(dir), { name: "n", email: "e@e" });
});

test("pushRun pushes a local run's patches to a new branch", async () => {
  // Canonical root: git resolves relative clone URLs through realpath (/private/var on macOS).
  const base = realpathSync(tempDir("hive-push-local-"));
  const remoteGit = join(base, "remote.git");
  const upGit = join(base, "up.git");
  const local = join(base, "local");

  git(base, "init", "-q", "--bare", "remote.git");
  git(base, "init", "-q", "--bare", "up.git");
  git(base, "clone", "-q", "remote.git", "local");
  const baseSha = commitFile(local, "f.txt", "one\n", "init");
  git(local, "push", "-q", "origin", "HEAD:refs/heads/main");
  execFileSync("git", ["--git-dir", remoteGit, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(local, "remote", "add", "upstream", upGit);

  const agent = join(base, "agent");
  git(base, "clone", "-q", local, agent);
  commitFile(agent, "f.txt", "two\n", "agent change");

  const dir = join(runsDir, "r1");
  mkdirSync(join(dir, "out"), { recursive: true });
  git(agent, "format-patch", "-q", "-o", join(dir, "out"), `${baseSha}..HEAD`);
  writeMeta(dir, { source: "local", repo: local, base: baseSha });

  const result = await pushRun(dir);
  assert.equal(result.branch, "hive/r1");
  assert.equal(result.commits, 1);
  assert.equal(result.url, remoteGit);
  assert.equal(gitDir(remoteGit, "log", "-1", "--format=%s", "hive/r1").trim(), "agent change");
  assert.equal(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).pushed.branch, "hive/r1");

  const second = await pushRun(dir, { branch: "feat/x", remote: "upstream" });
  assert.equal(second.branch, "feat/x");
  assert.equal(second.url, upGit);
  assert.equal(gitDir(upGit, "log", "-1", "--format=%s", "feat/x").trim(), "agent change");

  await assert.rejects(() => pushRun(dir, { branch: "bad..name" }), /Invalid branch/);

  // A repeat push to an existing branch is refused with a clear message, never forced.
  await assert.rejects(() => pushRun(dir), /branch hive\/r1 already exists.*--branch/);

  // --pr on a non-GitHub remote fails before anything is pushed.
  await assert.rejects(() => pushRun(dir, { branch: "pr/x", requireGithub: true }), /github\.com remote/);
  assert.equal(gitDir(remoteGit, "branch", "--list", "pr/x").trim(), "");

  const failed = join(runsDir, "r4");
  mkdirSync(failed, { recursive: true });
  writeMeta(failed, { source: "local", repo: local, base: baseSha, status: "failed" });
  await assert.rejects(() => pushRun(failed), /nothing to push|failed/);
});

test("pushRun pushes a remote run back to the URL it was cloned from, and applyRun refuses it", async () => {
  const base = realpathSync(tempDir("hive-push-remote-"));
  const remoteGit = join(base, "remote.git");
  const seed = join(base, "seed");

  git(base, "init", "-q", "--bare", "remote.git");
  git(base, "clone", "-q", remoteGit, "seed");
  commitFile(seed, "f.txt", "one\n", "init");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  execFileSync("git", ["--git-dir", remoteGit, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const dir = join(runsDir, "r2");
  mkdirSync(join(dir, "out"), { recursive: true });
  const baseSha = await prepareRepo(dir, remoteGit);

  const agent = join(base, "agent");
  git(base, "clone", "-q", remoteGit, agent);
  commitFile(agent, "f.txt", "two\n", "agent change");
  git(agent, "format-patch", "-q", "-o", join(dir, "out"), `${baseSha}..HEAD`);
  writeMeta(dir, { source: "remote", repo: remoteGit, base: baseSha });

  const result = await pushRun(dir);
  assert.equal(result.branch, "hive/r2");
  assert.equal(result.commits, 1);
  assert.equal(result.url, remoteGit);
  assert.equal(gitDir(remoteGit, "log", "-1", "--format=%s", "hive/r2").trim(), "agent change");

  await assert.rejects(() => applyRun(dir, remoteGit), /use hive push/);
});

test("openPr needs a pushed run with a github.com remote", async () => {
  const unpushed = join(runsDir, "r5");
  mkdirSync(unpushed, { recursive: true });
  writeMeta(unpushed, { source: "remote", repo: "/tmp/x", base: "abc" });
  await assert.rejects(() => openPr(unpushed), /push the run first/);

  const gitlab = join(runsDir, "r6");
  mkdirSync(gitlab, { recursive: true });
  writeMeta(gitlab, {
    source: "remote",
    repo: "https://gitlab.com/a/b.git",
    base: "abc",
    pushed: { branch: "hive/r6", url: "https://gitlab.com/a/b.git", at: 1 },
  });
  await assert.rejects(() => openPr(gitlab), /github\.com remote/);
});

test("pushRun blocks a patch that contains one of the host's API keys, and records the scan", async () => {
  const key = process.env.DEEPSEEK_API_KEY;
  const base = realpathSync(tempDir("hive-push-key-"));
  const remoteGit = join(base, "remote.git");
  const local = join(base, "local");
  git(base, "init", "-q", "--bare", "remote.git");
  git(base, "clone", "-q", "remote.git", "local");
  const baseSha = commitFile(local, "f.txt", "one\n", "init");
  git(local, "push", "-q", "origin", "HEAD:refs/heads/main");

  const dir = join(runsDir, "r-key");
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(
    join(dir, "out", "0001-secret.patch"),
    [
      "diff --git a/config.txt b/config.txt",
      "--- a/config.txt",
      "+++ b/config.txt",
      "@@ -0,0 +1 @@",
      `+token = ${key}`,
      "",
    ].join("\n"),
  );
  writeMeta(dir, { source: "local", repo: local, base: baseSha });

  let err;
  try {
    await pushRun(dir);
  } catch (e) {
    err = e;
  }
  assert.match(String(err?.message), /push refused: the changes contain one of your API keys/);
  assert.equal(err.code, "OUTPUT_SCAN_BLOCKED");
  const fresh = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  assert.equal(fresh.outputScan.blocked, true);
  assert.equal(fresh.outputScan.findings[0].kind, "known-key");
  assert.ok(!fresh.outputScan.findings[0].detail.includes(key));
  assert.equal(gitDir(remoteGit, "branch", "--list", "hive/r-key").trim(), "");
  assert.equal(fresh.pushed, undefined);
});

test("pushRun needs confirmation for sensitive files, and --yes-equivalent proceeds", async () => {
  const base = realpathSync(tempDir("hive-push-warn-"));
  const remoteGit = join(base, "remote.git");
  const local = join(base, "local");
  git(base, "init", "-q", "--bare", "remote.git");
  git(base, "clone", "-q", "remote.git", "local");
  const baseSha = commitFile(local, "f.txt", "one\n", "init");
  git(local, "push", "-q", "origin", "HEAD:refs/heads/main");

  const agent = join(base, "agent");
  git(base, "clone", "-q", local, agent);
  mkdirSync(join(agent, ".github", "workflows"), { recursive: true });
  writeFileSync(join(agent, ".github", "workflows", "ci.yml"), "name: CI\n");
  git(agent, "add", ".");
  git(agent, "commit", "-q", "-m", "add workflow");

  const dir = join(runsDir, "r-warn");
  mkdirSync(join(dir, "out"), { recursive: true });
  git(agent, "format-patch", "-q", "-o", join(dir, "out"), `${baseSha}..HEAD`);
  writeMeta(dir, { source: "local", repo: local, base: baseSha });

  let err;
  try {
    await pushRun(dir);
  } catch (e) {
    err = e;
  }
  assert.match(String(err?.message), /push needs confirmation/);
  assert.equal(err.code, "OUTPUT_SCAN_WARNINGS");
  assert.match(err.message, /ci-workflow \.github\/workflows\/ci\.yml/);
  assert.equal(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).outputScan.warned, true);

  const pushed = await pushRun(dir, { confirmWarnings: true });
  assert.equal(pushed.commits, 1);
  assert.equal(gitDir(remoteGit, "log", "-1", "--format=%s", "hive/r-warn").trim(), "add workflow");
});
