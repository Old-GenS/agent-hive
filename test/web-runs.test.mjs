// The web UI's run API: routes and shapes backed by the CLI run folders (no server process, no VM).
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fWebSocket from "@fastify/websocket";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed before any dist/ import: config.ts reads it at import time.
const root = mkdtempSync(join(tmpdir(), "hive-web-runs-"));
const ID = "demo-20260101-000000";
const RUN_DIR = join(root, ID);
mkdirSync(join(RUN_DIR, "io"), { recursive: true });
process.env.HIVE_RUNS_DIR = root;
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
process.env.HIVE_KEYS_FILE = join(root, "missing-keys");
process.env.MAX_CONCURRENT_SESSIONS = "2";

const { emptyUsage } = await import("../dist/render.js");
const { createSlots, default: webRunRoutes, liveCount, runToJSON, uiStatus } = await import("../dist/web-runs.js");

const meta = {
  repo: "https://github.com/me/demo.git",
  source: "remote",
  base: "0123456789abcdef0123456789abcdef01234567",
  provider: "deepseek",
  model: "deepseek-flash",
  thinking: "low",
  prompt: "Fix the widget\nwith tests",
  status: "done",
  pid: 1,
  commits: 0,
  usage: emptyUsage(),
  createdAt: 1767225600000,
  finishedAt: 1767225660000,
};
writeFileSync(join(RUN_DIR, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
writeFileSync(
  join(RUN_DIR, "io", "events.jsonl"),
  [
    JSON.stringify({ type: "hive_status", status: "running" }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    "",
  ].join("\n"),
);

// A bare app: no auth hook, just the websocket plugin the events route needs.
const app = Fastify();
await app.register(fWebSocket);
await app.register(webRunRoutes);
test.after(async () => {
  await app.close();
});

test("GET /runs lists the run folder newest first, as idle", async () => {
  assert.equal(liveCount(), 0);
  const res = await app.inject({ method: "GET", url: "/runs" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].sessionId, ID);
  assert.equal(body.runs[0].status, "idle");
  assert.equal(body.runs[0].title, "Fix the widget");
  assert.deepEqual(body.capacity, { running: 0, queued: 0, max: 2 });
});

test("GET /status returns the run's fields", async () => {
  const res = await app.inject({ method: "GET", url: `/status/${ID}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.sessionId, ID);
  assert.equal(body.title, "Fix the widget");
  assert.equal(body.status, "idle");
  assert.equal(body.isStreaming, false);
  assert.equal(body.repoSlug, "me/demo");
});

test("GET /status is 404 for a missing or malformed id", async () => {
  for (const url of ["/status/nope", "/status/..%2Fx"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, url);
    assert.deepEqual(res.json(), { error: "Session not found" });
  }
});

test("GET /export validates the format, then reports an empty run and an unknown id", async () => {
  const badFormat = await app.inject({ method: "GET", url: `/export/${ID}?format=tar` });
  assert.equal(badFormat.statusCode, 400);
  assert.deepEqual(badFormat.json(), { error: "format must be zip, bundle or report" });

  // This run has no out/*.patch, so there is nothing to build an archive from.
  const empty = await app.inject({ method: "GET", url: `/export/${ID}?format=zip` });
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(empty.json(), { error: "no commits to export" });

  const missing = await app.inject({ method: "GET", url: "/export/nope?format=zip" });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "Session not found" });
});

test("GET /export?format=report returns the run's Markdown report as an attachment", async () => {
  const res = await app.inject({ method: "GET", url: `/export/${ID}?format=report` });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^text\/markdown; charset=utf-8$/);
  const disposition = String(res.headers["content-disposition"]);
  assert.match(disposition, /^attachment; filename="demo-20260101-000000\.md"$/);
  assert.ok(res.body.includes("Fix the widget"), res.body);
  assert.ok(res.body.includes("## Prompt"), res.body);
});

test("POST /prompt rejects repo and newRepo together and a missing repository", async () => {
  const both = await app.inject({
    method: "POST",
    url: "/prompt",
    payload: { prompt: "x", repo: "me/demo", newRepo: { name: "demo" } },
  });
  assert.equal(both.statusCode, 400);
  assert.equal(both.json().error, "Send repo or newRepo, not both");

  const neither = await app.inject({ method: "POST", url: "/prompt", payload: { prompt: "x" } });
  assert.equal(neither.statusCode, 400);
  assert.match(neither.json().error, /pick a repository/i);
});

test("POST /prompt follow-up for an unknown run is 404", async () => {
  const res = await app.inject({ method: "POST", url: "/prompt", payload: { prompt: "x", sessionId: "nope" } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "Session not found" });
});

test("POST /abort is 409 for a run this process isn't running", async () => {
  const res = await app.inject({ method: "POST", url: `/abort/${ID}` });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /isn't running/);
});

test("uiStatus maps meta.json to the UI's statuses", () => {
  const at = { ...meta };
  assert.equal(uiStatus({ ...at, status: "done" }, false), "idle");
  assert.equal(uiStatus({ ...at, status: "failed" }, false), "failed");
  assert.equal(uiStatus({ ...at, status: "aborted" }, false), "aborted");
  // A run still marked running whose process is gone never finished.
  assert.equal(uiStatus({ ...at, status: "running" }, false), "failed");
  // Live runs are running whatever meta.json says…
  assert.equal(uiStatus({ ...at, status: "done" }, true), "running");
  assert.equal(uiStatus({ ...at, status: "failed" }, true), "running");
  // …except one still waiting for a free slot.
  assert.equal(uiStatus({ ...at, status: "queued" }, true), "queued");
  // A queued run whose process is gone never finished.
  assert.equal(uiStatus({ ...at, status: "queued" }, false), "failed");
});

test("createSlots runs max at once and queues the rest FIFO", async () => {
  const slots = createSlots(1);
  const ac = new AbortController();
  await slots.acquire(ac.signal);
  assert.equal(slots.running(), 1);
  assert.equal(slots.queued(), 0);

  const order = [];
  const first = slots.acquire(ac.signal).then(() => order.push("first"));
  const second = slots.acquire(ac.signal).then(() => order.push("second"));
  assert.equal(slots.queued(), 2);

  slots.release();
  await first;
  assert.deepEqual(order, ["first"]);
  assert.equal(slots.running(), 1);

  slots.release();
  await second;
  assert.deepEqual(order, ["first", "second"]);

  slots.release();
  assert.equal(slots.running(), 0);
});

test("createSlots removes an aborted waiter from the queue", async () => {
  const slots = createSlots(1);
  const busy = new AbortController();
  await slots.acquire(busy.signal);

  const queued = new AbortController();
  const waiting = slots.acquire(queued.signal);
  assert.equal(slots.queued(), 1);
  queued.abort();
  await assert.rejects(waiting, /aborted/);
  assert.equal(slots.queued(), 0);

  slots.release();
  assert.equal(slots.running(), 0);
});

test("createSlots setMax raises the limit and starts queued waiters right away", async () => {
  const slots = createSlots(1);
  await slots.acquire(new AbortController().signal);
  const order = [];
  const second = slots.acquire(new AbortController().signal).then(() => order.push("second"));
  const third = slots.acquire(new AbortController().signal).then(() => order.push("third"));
  assert.equal(slots.queued(), 2);

  slots.setMax(3);
  await Promise.all([second, third]);
  assert.deepEqual(order, ["second", "third"]);
  assert.equal(slots.running(), 3);
  assert.equal(slots.queued(), 0);

  slots.release();
  slots.release();
  slots.release();
  assert.equal(slots.running(), 0);
});

test("createSlots setMax lowering the limit lets running runs finish and holds new ones back", async () => {
  const slots = createSlots(2);
  await slots.acquire(new AbortController().signal);
  await slots.acquire(new AbortController().signal);
  slots.setMax(1);
  // Running runs are never stopped; they just finish before anything else starts.
  assert.equal(slots.running(), 2);

  const order = [];
  const next = slots.acquire(new AbortController().signal).then(() => order.push("next"));
  assert.equal(slots.queued(), 1);
  slots.release();
  await Promise.resolve();
  assert.deepEqual(order, [], "a release does not start a run while running >= max");

  slots.release();
  await next;
  assert.deepEqual(order, ["next"]);
  slots.release();
  assert.equal(slots.running(), 0);
});

test("runToJSON returns the old Task.toJSON fields", () => {
  const json = runToJSON(ID, meta, false);
  assert.equal(json.sessionId, ID);
  assert.equal(json.title, "Fix the widget");
  assert.equal(json.status, "idle");
  assert.equal(json.isStreaming, false);
  assert.equal(json.repo, meta.repo);
  assert.equal(json.resultBranch, undefined);
  assert.equal(json.commitsPushed, 0);
  assert.equal(json.changes, undefined);
  assert.equal(json.prUrl, undefined);
  assert.equal(json.issueUrl, undefined);
  assert.equal(json.repoSlug, "me/demo");
  assert.deepEqual(json.usage, emptyUsage());
  assert.equal(json.provider, "deepseek");
  assert.equal(json.model, "deepseek-flash");
  assert.equal(json.thinkingLevel, "low");
  assert.equal(typeof json.isolation, "string");
  assert.equal(json.createdAt, meta.createdAt);
  assert.equal(json.stepStartedAt, meta.createdAt);
  assert.equal(json.finishedAt, meta.finishedAt);

  const changes = { commits: ["Fix it"], files: [{ path: "a.txt", added: 1, removed: 0 }], moreFiles: 0 };
  assert.deepEqual(runToJSON(ID, meta, false, changes).changes, changes);

  const pushed = runToJSON(ID, { ...meta, commits: 3, pushed: { branch: "hive/x", url: "https://github.com/me/demo.git", at: 1 } }, false);
  assert.equal(pushed.resultBranch, "hive/x");
  assert.equal(pushed.commitsPushed, 3);
  assert.equal(pushed.repoSlug, "me/demo");

  const newProject = runToJSON(
    ID,
    { ...meta, source: "new", repo: "", newRepo: { name: "demo", private: true }, createdRepo: "me/demo" },
    false,
  );
  assert.equal(newProject.newRepo, "demo");
  assert.equal(newProject.createdRepo, "me/demo");
  assert.equal(newProject.repoSlug, "me/demo");
});

// ── run management: stars and Clear ──

const { existsSync, readFileSync, rmSync } = await import("node:fs");

/** Another run folder under the same runs dir, with the shared meta as its base. */
function makeRun(name, overrides) {
  const dir = join(root, name);
  mkdirSync(join(dir, "io"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, ...overrides }, null, 2) + "\n");
  return dir;
}

test("PUT /session/:id/kept stars a run, unstars it, and rejects a bad body or unknown run", async () => {
  const starred = await app.inject({ method: "PUT", url: `/session/${ID}/kept`, payload: { kept: true } });
  assert.equal(starred.statusCode, 200);
  assert.deepEqual(starred.json(), { sessionId: ID, kept: true });
  assert.equal(JSON.parse(readFileSync(join(RUN_DIR, "meta.json"), "utf8")).kept, true);
  assert.equal((await app.inject({ method: "GET", url: `/status/${ID}` })).json().kept, true);

  const unstarred = await app.inject({ method: "PUT", url: `/session/${ID}/kept`, payload: { kept: false } });
  assert.equal(unstarred.statusCode, 200);
  assert.deepEqual(unstarred.json(), { sessionId: ID, kept: false });
  assert.equal(JSON.parse(readFileSync(join(RUN_DIR, "meta.json"), "utf8")).kept, undefined);

  const unknown = await app.inject({ method: "PUT", url: "/session/nope/kept", payload: { kept: true } });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: "Session not found" });

  for (const payload of [{ kept: "yes" }, {}]) {
    const bad = await app.inject({ method: "PUT", url: `/session/${ID}/kept`, payload });
    assert.equal(bad.statusCode, 400, JSON.stringify(payload));
  }
});

test("runToJSON reports kept and the unpushed commits a delete would lose", () => {
  const kept = runToJSON(ID, { ...meta, kept: true }, false);
  assert.equal(kept.kept, true);

  const plain = runToJSON(ID, meta, false);
  assert.equal(plain.kept, false);
  assert.equal(plain.unpushedCommits, 0);

  const unpushed = runToJSON(ID, { ...meta, commits: 3 }, false);
  assert.equal(unpushed.unpushedCommits, 3);

  const pushed = runToJSON(
    ID,
    { ...meta, commits: 3, pushed: { branch: "hive/x", url: "https://github.com/me/demo.git", at: 1 } },
    false,
  );
  assert.equal(pushed.unpushedCommits, 0);
});

test("POST /sessions/clear deletes done runs, then every finished one, and keeps starred and live runs", async () => {
  const doneDir = makeRun("clear-done", { status: "done", pid: 2147483646, finishedAt: Date.now() });
  const failedDir = makeRun("clear-failed", { status: "failed", pid: 2147483646, finishedAt: Date.now() });
  const abortedDir = makeRun("clear-aborted", { status: "aborted", pid: 2147483646, finishedAt: Date.now() });
  const keptDir = makeRun("clear-kept", { status: "done", pid: 2147483646, finishedAt: Date.now(), kept: true });
  // A run still marked running whose owner is gone: "interrupted", finished all the same.
  const interruptedDir = makeRun("clear-interrupted", { status: "running", pid: 2147483646 });
  // A run this process is really running: never deleted.
  const liveDir = makeRun("clear-live", { status: "running", pid: process.pid });

  // "done" is the default: only finished-successfully runs, and not the starred or live ones.
  const done = await app.inject({ method: "POST", url: "/sessions/clear", payload: {} });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(new Set(done.json().deleted), new Set([ID, "clear-done"]));
  assert.deepEqual(done.json().skipped, []);
  assert.equal(existsSync(RUN_DIR), false);
  assert.equal(existsSync(doneDir), false);
  assert.equal(existsSync(failedDir), true);
  assert.equal(existsSync(abortedDir), true);
  assert.equal(existsSync(keptDir), true);
  assert.equal(existsSync(interruptedDir), true);
  assert.equal(existsSync(liveDir), true);

  // "finished" also takes failed, stopped and interrupted runs.
  const finished = await app.inject({
    method: "POST",
    url: "/sessions/clear",
    payload: { include: "finished" },
  });
  assert.equal(finished.statusCode, 200, finished.body);
  const body = finished.json();
  assert.ok(Array.isArray(body.deleted));
  assert.deepEqual(new Set(body.deleted), new Set(["clear-failed", "clear-aborted", "clear-interrupted"]));
  assert.deepEqual(body.skipped, []);
  assert.equal(existsSync(failedDir), false);
  assert.equal(existsSync(abortedDir), false);
  assert.equal(existsSync(interruptedDir), false);
  assert.equal(existsSync(keptDir), true);
  assert.equal(existsSync(liveDir), true);

  // A bad include value is rejected.
  const bad = await app.inject({ method: "POST", url: "/sessions/clear", payload: { include: "everything" } });
  assert.equal(bad.statusCode, 400);

  rmSync(keptDir, { recursive: true, force: true });
  rmSync(liveDir, { recursive: true, force: true });
});
