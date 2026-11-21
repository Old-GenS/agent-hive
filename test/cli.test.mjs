// CLI helpers: JSONL following, event rendering, run meta/apply, and the CLI entry point.
// The runs dir is a fresh temp dir set before importing any dist module, because config.ts reads
// HIVE_RUNS_DIR at import time.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runsDir = mkdtempSync(join(tmpdir(), "hive-cli-test-"));
process.env.HIVE_RUNS_DIR = runsDir;
process.env.HIVE_RUNTIME = "libkrun";
// Host git needs a committer identity for `git am`; the test machine has no git config.
process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || "t";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || "t@t";
process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || "t";
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || "t@t";

const { followJsonl } = await import("../dist/follow.js");
const { renderEvent, emptyUsage, addUsage } = await import("../dist/render.js");
const { resolveRun, applyRun } = await import("../dist/runs.js");

function makeRun(name, meta) {
  const dir = join(runsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return dir;
}

test("followJsonl reads only complete lines and resumes at the byte offset", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-follow-"));
  const path = join(dir, "events.jsonl");
  writeFileSync(path, '{"a":1}\n{"b"');
  const events = [];
  // A long interval means only the explicit poll() calls below read the file.
  const follower = followJsonl(path, (e) => events.push(e), 60_000);
  follower.poll();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { a: 1 });

  appendFileSync(path, ':2}\n');
  follower.poll();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { b: 2 });

  appendFileSync(path, "garbage\n");
  follower.poll();
  assert.equal(events.length, 2);
  follower.stop();
});

test("renderEvent renders assistant text, tool calls and tool errors in plain text", () => {
  assert.equal(
    renderEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "npm   test" } }),
    "  → bash npm test",
  );
  assert.equal(
    renderEvent({ type: "tool_execution_start", toolName: "read", args: { path: "a.txt" } }),
    "  → read a.txt",
  );
  const long = renderEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "x".repeat(300) } });
  assert.ok(long.length <= 109, `rendered length ${long.length}`);
  assert.ok(long.endsWith("…"));

  assert.equal(
    renderEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x" },
          { type: "text", text: "hi" },
        ],
      },
    }),
    "hi",
  );
  assert.equal(renderEvent({ type: "message_end", message: { role: "user", content: "hi" } }), undefined);
  assert.equal(renderEvent({ type: "tool_execution_end", toolName: "bash", isError: true }), "  ✗ bash failed");
});

test("addUsage totals assistant message usage", () => {
  const total = emptyUsage();
  const event = {
    type: "message_end",
    message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.5 } } },
  };
  addUsage(total, event);
  addUsage(total, event);
  assert.deepEqual(total, { input: 20, output: 10, cacheRead: 2, cacheWrite: 4, cost: 1 });
});

test("resolveRun takes a name, defaults to the newest run, and rejects other paths", () => {
  makeRun("r1", { createdAt: 1 });
  makeRun("r2", { createdAt: 2 });
  assert.ok(resolveRun("r1").endsWith("/r1"));
  assert.ok(resolveRun().endsWith("/r2"));
  assert.throws(() => resolveRun("/etc"), /not a run/);
  assert.throws(() => resolveRun("../x"), /not a run/);
});

test("applyRun applies to the work tree or replays the commits on a branch", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-apply-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

  git(repo, "init", "-q");
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const head = git(repo, "rev-parse", "HEAD").trim();

  const clone = join(base, "clone");
  git(base, "clone", "-q", repo, clone);
  writeFileSync(join(clone, "f.txt"), "two\n");
  writeFileSync(join(clone, "new.txt"), "new\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "agent change");

  const dir = join(runsDir, "r3");
  mkdirSync(join(dir, "out"), { recursive: true });
  git(clone, "format-patch", "-q", "-o", join(dir, "out"), `${head}..HEAD`);
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ status: "done", commits: 1, repo, base: head, createdAt: 3 }),
  );

  const status = await applyRun(dir, repo);
  assert.equal(git(repo, "rev-parse", "HEAD").trim(), head);
  const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.ok(porcelain.includes(" M f.txt"), porcelain);
  assert.ok(porcelain.includes("?? new.txt"), porcelain);
  assert.match(status, /f\.txt/);
  await assert.rejects(() => applyRun(dir, repo), /uncommitted/);

  git(repo, "checkout", "--", ".");
  git(repo, "clean", "-fdq");
  const result = await applyRun(dir, repo, "hive/t");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim(), "hive/t");
  assert.equal(git(repo, "log", "-1", "--format=%s").trim(), "agent change");
  assert.match(result, /hive\/t/);
});

test("CLI: --help, list and an unknown command", () => {
  const help = execFileSync(process.execPath, ["dist/cli.js", "--help"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(help.split("\n")[0], /^hive run/);
  for (const line of ["hive run", "hive log", "hive diff", "hive apply", "hive list", "hive clean"]) {
    assert.ok(help.includes(line), `help output mentions "${line}"`);
  }

  const emptyDir = mkdtempSync(join(tmpdir(), "hive-empty-"));
  const list = execFileSync(process.execPath, ["dist/cli.js", "list"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HIVE_RUNS_DIR: emptyDir },
  });
  assert.equal(list.trim(), "no runs");

  const bogus = spawnSync(process.execPath, ["dist/cli.js", "bogus"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(bogus.status, 1);
});

test("hive list colours a terminal listing, and stays plain with NO_COLOR", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-list-colour-"));
  const runDir = join(dir, "owner-repo-20240101-000000");
  mkdirSync(runDir, { recursive: true });
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
      commits: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0123 },
      createdAt: Date.now() - 7_200_000,
      finishedAt: Date.now() - 3_600_000,
    }),
  );

  const env = (extra) => {
    const result = { ...process.env, HIVE_RUNS_DIR: dir, ...extra };
    delete result.FORCE_COLOR;
    delete result.NO_COLOR;
    Object.assign(result, extra);
    return result;
  };
  const run = (extra) =>
    spawnSync(process.execPath, ["dist/cli.js", "list"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: env(extra),
    });

  const coloured = run({ FORCE_COLOR: "1" });
  assert.equal(coloured.status, 0, coloured.stderr);
  assert.match(coloured.stdout, /RUN/, "the coloured view has a table header");
  assert.match(coloured.stdout, /\u001b\[/, "the coloured view has ANSI escapes");
  assert.match(coloured.stdout, /owner-repo-20240101-000000/);

  const plain = run({ NO_COLOR: "1" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /\u001b\[/, "NO_COLOR means no ANSI escapes");
  assert.match(plain.stdout, /commit\(s\)/, "NO_COLOR keeps today's line format");
});

test("hive --version prints the version, from source marked as such", () => {
  const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  for (const flag of ["--version", "-V", "version"]) {
    const r = spawnSync(process.execPath, ["dist/cli.js", flag], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `hive ${version} (from source)\n`);
  }
});
