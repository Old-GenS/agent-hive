// The CLI run's stall watchdog: a run stops when nothing in work/ changed and no event arrived.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { changedWithin, startStallWatch } = await import("../dist/stall.js");

const THIRTY_MINUTES = 30 * 60_000;

/** A fresh temp dir, removed when the test ends. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "hive-stall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A temp dir whose file (and the dir itself) last changed 30 minutes ago. */
function oldDir(t) {
  const dir = tempDir(t);
  const file = join(dir, "work.txt");
  writeFileSync(file, "done\n");
  const old = new Date(Date.now() - THIRTY_MINUTES);
  utimesSync(file, old, old);
  utimesSync(dir, old, old);
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait up to `ms` for `check()` to become true. */
async function eventually(check, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await sleep(10);
  }
  return check();
}

test("changedWithin is true for a file just written", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "work.txt"), "just now\n");
  assert.equal(await changedWithin(dir, 15), true);
});

test("changedWithin is false when the file and dir are 30 minutes old", async (t) => {
  const dir = oldDir(t);
  assert.equal(await changedWithin(dir, 15), false);
});

test("startStallWatch with stallMin 0 never calls onStall", async (t) => {
  let calls = 0;
  const watch = startStallWatch({
    dir: oldDir(t),
    stallMin: 0,
    lastActivity: () => Date.now() - 20 * 60_000,
    onStall: () => calls++,
    intervalMs: 20,
  });
  await sleep(200);
  watch.stop();
  assert.equal(calls, 0);
});

test("startStallWatch calls onStall exactly once when the run is idle and the dir is old", async (t) => {
  let calls = 0;
  const watch = startStallWatch({
    dir: oldDir(t),
    stallMin: 15,
    lastActivity: () => Date.now() - 20 * 60_000,
    onStall: () => calls++,
    intervalMs: 50,
  });
  try {
    assert.equal(await eventually(() => calls > 0, 2000), true, "onStall is called within 2s");
    await sleep(200); // give a broken watch time to call it again
    assert.equal(calls, 1);
  } finally {
    watch.stop();
  }
});

test("startStallWatch does not call onStall while activity is recent", async (t) => {
  let calls = 0;
  const watch = startStallWatch({
    dir: oldDir(t),
    stallMin: 15,
    lastActivity: () => Date.now(),
    onStall: () => calls++,
    intervalMs: 50,
  });
  try {
    await sleep(500);
    assert.equal(calls, 0);
  } finally {
    watch.stop();
  }
});
