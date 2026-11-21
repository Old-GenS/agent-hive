// The beta build's rootfs reuse decision: force, no previous info, a changed image tree, security
// updates, the 14-day batching rule, and plain reuse.
import test from "node:test";
import assert from "node:assert/strict";
import { decide, REBUILD_AFTER_DAYS } from "../scripts/rootfs-plan.mjs";

const DAY = 24 * 60 * 60 * 1000;
const info = { rootfs: "0123456789ab", imageTree: "abc", built: "2026-01-01T00:00:00Z" };
const built = Date.parse(info.built);

function base(overrides = {}) {
  return {
    info,
    imageTree: "abc",
    now: built + DAY,
    securityUpdates: 0,
    anyUpdates: 0,
    ...overrides,
  };
}

test("force rebuilds", () => {
  assert.deepEqual(decide(base({ force: true })), { action: "rebuild", reason: "forced" });
});

test("no previous rootfs rebuilds", () => {
  assert.deepEqual(decide(base({ info: null })), { action: "rebuild", reason: "no previous rootfs" });
  assert.deepEqual(decide(base({ info: undefined })), { action: "rebuild", reason: "no previous rootfs" });
});

test("a changed image tree rebuilds", () => {
  assert.deepEqual(decide(base({ imageTree: "def" })), { action: "rebuild", reason: "image/ changed" });
});

test("pending security updates rebuild", () => {
  assert.deepEqual(decide(base({ securityUpdates: 3 })), {
    action: "rebuild",
    reason: "3 security updates",
  });
  // Security wins even when the rootfs is young.
  assert.deepEqual(decide(base({ securityUpdates: 1, anyUpdates: 1 })), {
    action: "rebuild",
    reason: "1 security updates",
  });
});

test("updates rebuild once the rootfs is old enough", () => {
  assert.deepEqual(decide(base({ anyUpdates: 6, now: built + REBUILD_AFTER_DAYS * DAY })), {
    action: "rebuild",
    reason: `6 updates, rootfs is ${REBUILD_AFTER_DAYS} days old`,
  });
});

test("updates do not rebuild a young rootfs", () => {
  assert.deepEqual(decide(base({ anyUpdates: 6, now: built + (REBUILD_AFTER_DAYS - 1) * DAY })), {
    action: "reuse",
    reason: `rootfs ${info.rootfs} is current`,
  });
});

test("a current rootfs is reused", () => {
  assert.deepEqual(decide(base()), { action: "reuse", reason: `rootfs ${info.rootfs} is current` });
});

test("now may be a Date", () => {
  assert.deepEqual(decide(base({ now: new Date(built + 1000) })), {
    action: "reuse",
    reason: `rootfs ${info.rootfs} is current`,
  });
});
