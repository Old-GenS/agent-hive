// The disk watchdog: measuring a run's size and the free space on its disk, and the timers that
// stop a step past `HIVE_RUN_DISK_MAX_GB` / below `HIVE_MIN_FREE_DISK_GB`. No VM is booted.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hive-diskwatch-"));

const { usedBytes, freeBytes, startDiskWatch } = await import("../dist/diskwatch.js");

const MB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => rmSync(root, { recursive: true, force: true }));

test("usedBytes counts the files in a folder", async () => {
  const dir = join(root, "run");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(MB));
  const used = await usedBytes([dir]);
  assert.equal(typeof used, "number");
  assert.ok(used >= 1_000_000, `expected at least 1 000 000 bytes, got ${used}`);
});

test("usedBytes sums several paths", async () => {
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, "one.bin"), Buffer.alloc(MB));
  writeFileSync(join(b, "two.bin"), Buffer.alloc(MB));
  const both = await usedBytes([a, b]);
  const one = await usedBytes([a]);
  assert.ok(both >= 2_000_000);
  assert.ok(one >= 1_000_000);
});

test("usedBytes does not follow a symlink to a large outside file", async () => {
  const dir = join(root, "symlinked");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "small.bin"), Buffer.alloc(MB));
  const outside = join(root, "outside.bin");
  writeFileSync(outside, Buffer.alloc(8 * MB));
  symlinkSync(outside, join(dir, "outside-link"));
  const used = await usedBytes([dir]);
  assert.equal(typeof used, "number");
  assert.ok(used >= 1_000_000);
  assert.ok(used < 4 * MB, `the symlinked file must not count, got ${used}`);
});

test("usedBytes returns undefined for a missing path", async () => {
  assert.equal(await usedBytes([join(root, "does-not-exist")]), undefined);
});

test("freeBytes returns a positive number for a real folder", () => {
  const free = freeBytes(root);
  assert.equal(typeof free, "number");
  assert.ok(free > 0);
});

test("freeBytes returns undefined for a missing path", () => {
  assert.equal(freeBytes(join(root, "does-not-exist")), undefined);
});

test("startDiskWatch stops a run past the size cap, once", async () => {
  const reasons = [];
  const watch = startDiskWatch({
    paths: [root],
    maxBytes: 2 * 1024 ** 3,
    minFreeBytes: 0,
    sizeIntervalMs: 20,
    measureUsed: async () => 3 * 1024 ** 3,
    onExceeded: (reason) => reasons.push(reason),
  });
  await sleep(150);
  watch.stop();
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0], "stopped: the run used more than 2 GB of disk (HIVE_RUN_DISK_MAX_GB)");
});

test("startDiskWatch stops a run below the free-space floor, once", async () => {
  const reasons = [];
  const watch = startDiskWatch({
    paths: [root],
    maxBytes: 0,
    minFreeBytes: 2 * 1024 ** 3,
    freeIntervalMs: 20,
    measureFree: () => 1 * 1024 ** 3,
    onExceeded: (reason) => reasons.push(reason),
  });
  await sleep(150);
  watch.stop();
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0], "stopped: less than 2 GB of disk left on this computer (HIVE_MIN_FREE_DISK_GB)");
});

test("startDiskWatch never stops on undefined or within-limit measurements", async () => {
  const reasons = [];
  const watch = startDiskWatch({
    paths: [root],
    maxBytes: 2 * 1024 ** 3,
    minFreeBytes: 2 * 1024 ** 3,
    freeIntervalMs: 20,
    sizeIntervalMs: 20,
    measureUsed: async () => undefined,
    measureFree: () => undefined,
    onExceeded: (reason) => reasons.push(reason),
  });
  await sleep(150);
  watch.stop();
  assert.deepEqual(reasons, []);

  const fine = [];
  const within = startDiskWatch({
    paths: [root],
    maxBytes: 2 * 1024 ** 3,
    minFreeBytes: 2 * 1024 ** 3,
    freeIntervalMs: 20,
    sizeIntervalMs: 20,
    measureUsed: async () => 1 * 1024 ** 2,
    measureFree: () => 100 * 1024 ** 3,
    onExceeded: (reason) => fine.push(reason),
  });
  await sleep(150);
  within.stop();
  assert.deepEqual(fine, []);
});

test("startDiskWatch never calls onExceeded after stop()", async () => {
  const reasons = [];
  const watch = startDiskWatch({
    paths: [root],
    maxBytes: 1,
    minFreeBytes: 1,
    freeIntervalMs: 20,
    sizeIntervalMs: 20,
    measureUsed: async () => 1024 ** 4,
    measureFree: () => 0,
    onExceeded: (reason) => reasons.push(reason),
  });
  watch.stop();
  await sleep(150);
  assert.deepEqual(reasons, []);
});

test("startDiskWatch starts no timers when both limits are 0", async () => {
  const reasons = [];
  const watch = startDiskWatch({
    paths: [root],
    maxBytes: 0,
    minFreeBytes: 0,
    freeIntervalMs: 10,
    sizeIntervalMs: 10,
    measureUsed: async () => 1024 ** 4,
    measureFree: () => 0,
    onExceeded: (reason) => reasons.push(reason),
  });
  await sleep(100);
  watch.stop();
  assert.deepEqual(reasons, []);
});

test("startDiskWatch only runs one size check at a time", async () => {
  let calls = 0;
  let running = 0;
  let overlapped = false;
  const watched = startDiskWatch({
    paths: [root],
    maxBytes: 2 * 1024 ** 3,
    minFreeBytes: 0,
    sizeIntervalMs: 5,
    measureUsed: async () => {
      calls += 1;
      running += 1;
      if (running > 1) overlapped = true;
      await sleep(30);
      running -= 1;
      return 0;
    },
    onExceeded: () => {},
  });
  await sleep(150);
  watched.stop();
  assert.ok(calls > 1, "expected several size checks");
  assert.equal(overlapped, false);
});

test("usedBytes still counts a tree with an unreadable folder", { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-du-locked-"));
  try {
    writeFileSync(join(dir, "big"), Buffer.alloc(1024 * 1024));
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "x"), "x");
    chmodSync(join(dir, "locked"), 0o000);
    const used = await usedBytes([dir]);
    assert.ok(used !== undefined && used >= 1_000_000, `got ${used}`);
  } finally {
    chmodSync(join(dir, "locked"), 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});
