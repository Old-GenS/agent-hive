// Startup cleanup: stopping VMs left by a crashed hive and pruning finished runs past the
// retention limit. No VM is booted and no real process is signalled.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed before any dist/ import: config.ts reads them at import time.
const root = mkdtempSync(join(tmpdir(), "hive-cleanup-"));
const runsDir = join(root, "runs");
const procRoot = join(root, "proc");
mkdirSync(runsDir);
mkdirSync(procRoot);
process.env.HIVE_RUNS_DIR = runsDir;
process.env.HIVE_VM_CACHE = join(root, "vm-cache");
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
process.env.HIVE_KEYS_FILE = join(root, "missing-keys");
delete process.env.HIVE_RUN_RETENTION_DAYS;
process.env.DEEPSEEK_API_KEY = "sk-test";

const { config } = await import("../dist/config.js");
const { readMeta, recoverRuns, pruneRuns, setKept } = await import("../dist/runs.js");

const DAY = 86_400_000;

function makeRun(name, meta) {
  const dir = join(runsDir, name);
  mkdirSync(join(dir, "io"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return dir;
}

function makeProc(pid, args) {
  mkdirSync(join(procRoot, String(pid)), { recursive: true });
  writeFileSync(join(procRoot, String(pid), "cmdline"), args.join("\0") + "\0");
}

function baseMeta(overrides) {
  return {
    repo: "https://github.com/me/demo.git",
    source: "remote",
    base: "",
    provider: "deepseek",
    model: "deepseek-flash",
    thinking: "low",
    prompt: "x",
    status: "running",
    pid: 2147483646,
    commits: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    createdAt: Date.now(),
    ...overrides,
  };
}

test("recoverRuns stops the VM of a dead run and marks it failed", () => {
  const staleDir = makeRun("stale-run", baseMeta({ status: "running" }));
  const doneDir = makeRun("done-run", baseMeta({ status: "done", pid: 999999, finishedAt: Date.now() - 1000 }));

  // A hive-vm process holding the stale run's work mount.
  makeProc(11111, ["pasta", "--", "/work/vm/hive-vm", "--share", `${staleDir}/work:/work`]);
  // An unrelated hive-vm process (another run) and a non-numeric proc entry.
  makeProc(22222, ["/work/vm/hive-vm", "--share", "/elsewhere/run/work:/work"]);
  writeFileSync(join(procRoot, "self"), "not a pid dir");
  // A hive-vm-looking process for the finished run must be left alone.
  makeProc(33333, ["/work/vm/hive-vm", "--share", `${doneDir}/work:/work`]);

  const killed = [];
  const recovered = recoverRuns({ procRoot, kill: (pid) => killed.push(pid) });

  assert.deepEqual(recovered, ["stale-run"]);
  assert.deepEqual(killed, [11111]);
  const stale = readMeta(staleDir);
  assert.equal(stale.status, "failed");
  assert.equal(stale.error, "interrupted (hive stopped)");
  assert.equal(typeof stale.finishedAt, "number");
  // A finished run is untouched.
  assert.equal(readMeta(doneDir).status, "done");
});

test("pruneRuns deletes runs finished more than 14 days ago and keeps the rest", () => {
  const now = Date.now();
  const oldDir = makeRun("old-run", baseMeta({ status: "done", finishedAt: now - 15 * DAY }));
  const recentDir = makeRun("recent-run", baseMeta({ status: "done", finishedAt: now - DAY }));
  const runningDir = makeRun("running-run", baseMeta({ status: "running", finishedAt: undefined }));

  assert.deepEqual(pruneRuns(now), ["old-run"]);
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(recentDir), true);
  assert.equal(existsSync(runningDir), true);
});

test("pruneRuns keeps everything when HIVE_RUN_RETENTION_DAYS is 0", () => {
  const now = Date.now();
  const oldDir = makeRun("old-run-0", baseMeta({ status: "done", finishedAt: now - 15 * DAY }));

  const saved = config.runRetentionDays;
  config.runRetentionDays = 0;
  try {
    assert.deepEqual(pruneRuns(now), []);
  } finally {
    config.runRetentionDays = saved;
  }
  assert.equal(existsSync(oldDir), true);
  assert.equal(JSON.parse(readFileSync(join(oldDir, "meta.json"), "utf8")).status, "done");
});

test("pruneRuns skips a starred run past retention but still deletes an unstarred one", () => {
  const now = Date.now();
  const starredDir = makeRun("starred-old", baseMeta({ status: "done", finishedAt: now - 15 * DAY, kept: true }));
  const plainDir = makeRun("plain-old", baseMeta({ status: "done", finishedAt: now - 15 * DAY }));

  assert.ok(pruneRuns(now).includes("plain-old"));
  assert.equal(existsSync(starredDir), true);
  assert.equal(existsSync(plainDir), false);
});

test("setKept stars and unstars a run, round-tripping through meta.json", () => {
  const dir = makeRun("star-me", baseMeta({ status: "done", finishedAt: Date.now() }));

  const starred = setKept(dir, true);
  assert.equal(starred.kept, true);
  assert.equal(readMeta(dir).kept, true);

  const unstarred = setKept(dir, false);
  assert.equal(unstarred.kept, undefined);
  assert.equal(readMeta(dir).kept, undefined);

  // The rest of the meta is untouched.
  assert.equal(readMeta(dir).status, "done");
});
