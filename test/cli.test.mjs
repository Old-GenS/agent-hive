// CLI helpers: JSONL following, event rendering, run meta/apply, and the CLI entry point.
// The runs dir is a fresh temp dir set before importing any dist module, because config.ts reads
// HIVE_RUNS_DIR at import time.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const { renderEvent, renderEventStyled, emptyUsage, addUsage } = await import("../dist/render.js");
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

// The agent's text is untrusted: it may carry escape sequences aimed at the person's terminal (an
// OSC 52 clipboard write, an OSC 8 link, cursor motion that paints over hive's own lines). hive is
// the only path from inside the sandbox to that terminal, so it drops the bytes an escape needs.
test("renderEvent strips terminal escapes out of agent text, and keeps newlines and tabs", () => {
  const escapes = "\u001b]52;c;cGF3bmVk\u0007\u001b[2J\u001b[1;1H\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007";
  const text = renderEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: `one\n\ttwo ${escapes} three` }] },
  });
  assert.equal(text, "one\n\ttwo click three", "the sequences and their control bytes are gone; the link text stays");
  assert.ok(!/\u001b/.test(text ?? ""));

  // The tool summary path collapses whitespace but never dropped ESC, which a tty would act on.
  const call = renderEvent({
    type: "tool_execution_start",
    toolName: "bash",
    args: { command: "echo \u001b]52;c;cGF3bmVk\u0007" },
  });
  assert.equal(call, "  → bash echo");

  // A model error message reaches the same terminal.
  const failed = renderEvent({
    type: "message_end",
    message: { role: "assistant", errorMessage: "boom\u001b[31m!\u001b[0m" },
  });
  assert.equal(failed, "error: boom!");

  // A bare carriage return repaints the current line, which is how hive's own output gets faked.
  assert.equal(renderEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok\rdone" }] } }), "okdone");
});

// The styled path adds hive's own escapes, so the agent's must go first — otherwise a stripped
// message could still reshape what a person sees.
test("renderEventStyled removes agent escapes and keeps its own colour", async () => {
  const { renderEventStyled } = await import("../dist/render.js");
  const out = renderEventStyled(
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "**hi**\u001b]52;c;cGF3bmVk\u0007" }] },
    },
    { enabled: true, width: 80 },
  );
  assert.ok(out.includes("\u001b[1m"), "hive's bold survives");
  assert.ok(!out.includes("]52;"), "the agent's clipboard write does not");
});

// The tool name is agent-chosen too, so renderEvent and renderEventStyled must drop its escapes
// exactly as they do for assistant text and tool arguments.
test("renderEvent and renderEventStyled strip terminal escapes out of the tool name", () => {
  const events = [
    { type: "tool_execution_start", toolName: "bash\u001b]52;c;aGk=\u0007x", args: { command: "ls" } },
    { type: "tool_execution_end", isError: true, toolName: "bash\u001b[2J" },
  ];
  for (const event of events) {
    const plain = renderEvent(event);
    assert.ok(!/[\u001b\u0007]/.test(plain ?? ""), `renderEvent left an escape in ${JSON.stringify(plain)}`);
    const styled = renderEventStyled(event, { enabled: true });
    const unstyled = styled ?? "";
    assert.ok(
      !/[\u001b\u0007]/.test(unstyled.replace(/\u001b\[[0-9;]*m/g, "")),
      `renderEventStyled left an agent escape in ${JSON.stringify(styled)}`,
    );
  }
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

test("hive --version prints the version, from source naming the checkout's commit", () => {
  // A checkout names itself from git (src/source-version.ts), not package.json's never-bumped
  // version. CI checks out a detached merge commit with no tags, so both forms are accepted.
  for (const flag of ["--version", "-V", "version"]) {
    const r = spawnSync(process.execPath, ["dist/cli.js", flag], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^hive from source: [0-9a-f]{7}( on \S+| \(detached\))/);
  }
});

test("continue arguments: a run name, a prompt, or both", () => {
  const cliUrl = new URL("../dist/cli.js", import.meta.url).href;
  // cli.ts runs main() when imported; a child process swallows that usage text and prints the
  // function's answer instead, so the test process never runs the CLI's main.
  const probe = (positionals, runs) => {
    const script = `
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
const { resolveContinueArgs, DEFAULT_CONTINUE_PROMPT } = await import(${JSON.stringify(cliUrl)});
process.stdout.write = write;
const runs = new Set(${JSON.stringify(runs)});
write(JSON.stringify(resolveContinueArgs(${JSON.stringify(positionals)}, (name) => runs.has(name))));
`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    return JSON.parse(out);
  };
  const prompt = "Continue the task from where you left off; don't redo finished work.";
  assert.deepEqual(probe([], []), { prompt });
  assert.deepEqual(probe(["r1"], ["r1"]), { run: "r1", prompt });
  assert.deepEqual(probe(["r1", "do more"], ["r1"]), { run: "r1", prompt: "do more" });
  assert.deepEqual(probe(["fix the bug"], ["r1"]), { prompt: "fix the bug" });
});

// ── run management: hive keep and clean --all ──

/** A finished run's meta, as `hive list`/`hive keep` read it. */
function finishedMeta(overrides = {}) {
  return {
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
    createdAt: Date.now() - 7_200_000,
    finishedAt: Date.now() - 3_600_000,
    ...overrides,
  };
}

/** A runs dir with one run folder per (name, meta) pair. */
function makeRunsDir(prefix, runs) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, meta] of Object.entries(runs)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  }
  return dir;
}

function cli(args, runsDir) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HIVE_RUNS_DIR: runsDir, NO_COLOR: "1" },
  });
}

test("hive keep stars and unstars a run, and hive list marks it with ★", () => {
  const name = "demo-20240101-000000";
  const dir = makeRunsDir("hive-keep-", { [name]: finishedMeta() });

  const keep = cli(["keep", name], dir);
  assert.equal(keep.status, 0, keep.stderr);
  assert.match(keep.stdout, new RegExp(`^hive: starred ${name}$`, "m"));
  assert.equal(JSON.parse(readFileSync(join(dir, name, "meta.json"), "utf8")).kept, true);

  const list = cli(["list"], dir);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /done ★/, list.stdout);

  const off = cli(["keep", "--off", name], dir);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, new RegExp(`^hive: unstarred ${name}$`, "m"));
  assert.equal(JSON.parse(readFileSync(join(dir, name, "meta.json"), "utf8")).kept, undefined);
  assert.doesNotMatch(cli(["list"], dir).stdout, /★/);

  assert.equal(cli(["keep"], dir).status, 1, "keep without a run name is a usage error");
  assert.equal(cli(["keep", "--off", "nope"], dir).status, 1, "an unknown run is an error");
});

test("hive clean --all skips a starred run and deletes the rest", () => {
  const dir = makeRunsDir("hive-clean-all-", {
    "plain-run": finishedMeta(),
    "kept-run": finishedMeta({ kept: true }),
  });

  const clean = cli(["clean", "--all"], dir);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^hive: cleaned plain-run$/m);
  assert.doesNotMatch(clean.stdout, /cleaned kept-run/);
  assert.match(clean.stderr, /^hive: kept kept-run \(starred\)$/m);
  assert.equal(existsSync(join(dir, "plain-run")), false);
  assert.equal(existsSync(join(dir, "kept-run")), true);
});

test("hive --help mentions keep", () => {
  const help = execFileSync(process.execPath, ["dist/cli.js", "--help"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(help, /^hive keep \[--off\] <run>$/m);
});

test("run and new reject --replace-instructions without --instructions, and a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-cli-instructions-"));
  for (const command of [["run", "--replace-instructions", "do work"], ["new", "demo", "--replace-instructions", "build it"]]) {
    const result = cli(command, dir);
    assert.equal(result.status, 1, `${command[0]} should exit 1`);
    assert.match(`${result.stdout}${result.stderr}`, /--replace-instructions needs --instructions <file>/);
  }

  for (const command of [["run", "--instructions", join(dir, "missing.md"), "do work"], ["new", "demo", "--instructions", join(dir, "missing.md"), "build it"]]) {
    const result = cli(command, dir);
    assert.equal(result.status, 1, `${command[0]} should exit 1`);
    assert.match(`${result.stdout}${result.stderr}`, /cannot read instructions file/);
  }
});

test("run and new parse --offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-cli-offline-"));
  for (const command of [
    ["run", "--offline", "--instructions", join(dir, "missing.md"), "do work"],
    ["new", "demo", "--offline", "--instructions", join(dir, "missing.md"), "build it"],
  ]) {
    const result = cli(command, dir);
    assert.equal(result.status, 1, `${command[0]} should exit 1`);
    // The missing file is reached only after --offline parsed without an unknown-option error.
    assert.match(`${result.stdout}${result.stderr}`, /cannot read instructions file/);
  }
});

test("hive login without github prints the usage, and --help mentions it", () => {
  const help = execFileSync(process.execPath, ["dist/cli.js", "--help"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(help, /^hive login github$/m);

  for (const args of [["login"], ["login", "gitlab"]]) {
    const result = spawnSync(process.execPath, ["dist/cli.js", ...args], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /hive login github/);
  }
});
