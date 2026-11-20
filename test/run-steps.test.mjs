// The CLI run pipeline's pure pieces: the review loop's LGTM check and prompt, and startRun's
// validation (no VM is booted by any case here).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed before any dist/ import: config.ts reads them at import time.
const root = mkdtempSync(join(tmpdir(), "hive-run-steps-"));
process.env.HIVE_RUNS_DIR = root;
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
process.env.HIVE_KEYS_FILE = join(root, "missing-keys");
process.env.HIVE_VM_CACHE = join(root, "vm-cache");
process.env.DEEPSEEK_API_KEY = "sk-test";
delete process.env.DEFAULT_PROVIDER;
delete process.env.DEFAULT_MODEL;

const { REVIEW_PROMPT, isLgtm, slimEvents, shouldReview, startRun, stepMounts, timeNote, usageWriteDue } =
  await import("../dist/runs.js");

const signal = () => new AbortController().signal;
const noop = () => {};

test("isLgtm accepts a leading LGTM in any case and nothing else", () => {
  assert.equal(isLgtm("LGTM"), true);
  assert.equal(isLgtm("  lgtm\nok"), true);
  assert.equal(isLgtm("LGTM — nothing to fix"), true);
  assert.equal(isLgtm("Not LGTM"), false);
  assert.equal(isLgtm(""), false);
  assert.equal(isLgtm("I found a bug"), false);
});

test("shouldReview skips the cycles only when a done run committed nothing", () => {
  assert.equal(shouldReview({ status: "done", cycles: 2, commits: 0 }), false);
  assert.equal(shouldReview({ status: "done", cycles: 2, commits: undefined }), true);
  assert.equal(shouldReview({ status: "done", cycles: 2, commits: 3 }), true);
  assert.equal(shouldReview({ status: "failed", cycles: 2, commits: 3 }), false);
  assert.equal(shouldReview({ status: "done", cycles: 0, commits: 3 }), false);
});

test("usageWriteDue saves at most every 5 seconds and only when the cost changed", () => {
  assert.equal(usageWriteDue(10_000, 5_000, true), true);
  assert.equal(usageWriteDue(9_999, 5_000, true), false);
  assert.equal(usageWriteDue(10_000, 5_000, false), false);
  assert.equal(usageWriteDue(10_000, 9_000, true), false);
});

test("REVIEW_PROMPT includes the task and the base commit", () => {
  const prompt = REVIEW_PROMPT("add a widget", "abc123");
  assert.match(prompt, /add a widget/);
  assert.match(prompt, /abc123/);
  assert.match(prompt, /LGTM/);
});

test("timeNote tells the agent its deadline in UTC", () => {
  const note = timeNote(60, new Date("2026-01-01T10:00:00Z"));
  assert.match(note, /60 minutes/);
  assert.match(note, /2026-01-01T11:00:00Z/);
  assert.match(note, /date -u/);
  assert.match(note, /Commit as you go/);
});

test("slimEvents drops streaming-only events and keeps everything else", () => {
  const text = [
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }),
    JSON.stringify({ type: "tool_execution_update" }),
    JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
    "not json",
    "",
  ].join("\n");
  const slim = slimEvents(text);
  assert.ok(!slim.includes("message_update"));
  assert.ok(!slim.includes("tool_execution_update"));
  assert.ok(slim.includes('"message_start"'));
  assert.ok(slim.includes('"message_end"'));
  assert.ok(slim.includes("not json"));
  // A trailing newline is preserved; only the event lines are dropped.
  assert.equal(slimEvents('{"type":"message_update"}\n'), "\n");
});

test("stepMounts shares the work copy and the VM cache, and nothing else", () => {
  const mounts = stepMounts(join(root, "run"));
  assert.ok(mounts.length <= 2, `expected at most 2 mounts, got ${mounts.length}`);
  assert.deepEqual(
    mounts.map((m) => m.container),
    ["/work", "/root/.cache"],
  );
  assert.ok(!mounts.some((m) => m.container === "/session" || m.container === "/root/.npm"));
  assert.equal(mounts[0].host, join(root, "run", "work"));
  assert.equal(mounts[1].host, join(root, "vm-cache"));
  assert.equal(mounts[1].shared, true);
});

test("stepMounts leaves the VM cache out when it is disabled", () => {
  // config.ts reads HIVE_VM_CACHE at import time, so the disabled case needs its own process.
  const url = new URL("../dist/runs.js", import.meta.url).href;
  const probe = `const { stepMounts } = await import(${JSON.stringify(url)});
process.stdout.write(JSON.stringify(stepMounts("/tmp/hive-step-mounts-probe")));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, HIVE_VM_CACHE: "" },
  });
  assert.deepEqual(JSON.parse(out), [{ host: "/tmp/hive-step-mounts-probe/work", container: "/work" }]);
});

test("startRun needs exactly one source", async () => {
  const two = startRun({
    repo: root,
    remote: { url: "https://github.com/me/demo.git", name: "demo" },
    prompt: "x",
    onEvent: noop,
    signal: signal(),
  });
  await assert.rejects(two, /startRun needs exactly one of repo, remote or newRepo/);

  const none = startRun({ prompt: "x", onEvent: noop, signal: signal() });
  await assert.rejects(none, /startRun needs exactly one of repo, remote or newRepo/);
});

test("startRun validates a new project name", async () => {
  const bad = startRun({
    newRepo: { name: "bad name" },
    prompt: "x",
    onEvent: noop,
    signal: signal(),
  });
  await assert.rejects(bad, /Project name may only use letters, digits, '-', '_' and '.' \(max 100\)/);
});

test("startRun rejects review cycles outside 0-5", async () => {
  const tooMany = startRun({
    remote: { url: "https://github.com/me/demo.git", name: "demo" },
    reviewCycles: 9,
    prompt: "x",
    onEvent: noop,
    signal: signal(),
  });
  await assert.rejects(tooMany, /reviewCycles must be 0-5/);
});
