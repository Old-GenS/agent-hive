// src/build-info.ts: the build label a test build's server reports. The label ends up in a
// banner, so it is sanitised here and not in the UI.
import test from "node:test";
import assert from "node:assert/strict";
import { buildInfo } from "../dist/build-info.js";

test("buildInfo is undefined without a channel", () => {
  assert.equal(buildInfo({}), undefined);
  assert.equal(buildInfo({ HIVE_BUILD_CHANNEL: "" }), undefined);
  assert.equal(buildInfo({ HIVE_BUILD_CHANNEL: "   " }), undefined);
});

test("buildInfo returns a test channel and its label", () => {
  assert.deepEqual(buildInfo({ HIVE_BUILD_CHANNEL: "test", HIVE_BUILD_LABEL: "test-4-1.2.4 · abc1234" }), {
    channel: "test",
    label: "test-4-1.2.4 · abc1234",
  });
});

test("buildInfo trims the channel and the label", () => {
  assert.deepEqual(buildInfo({ HIVE_BUILD_CHANNEL: " test ", HIVE_BUILD_LABEL: "  test-4-1.2.4  " }), {
    channel: "test",
    label: "test-4-1.2.4",
  });
});

test("buildInfo rejects a channel that is not a short slug", () => {
  assert.equal(buildInfo({ HIVE_BUILD_CHANNEL: "Bad Channel!" }), undefined);
  assert.equal(buildInfo({ HIVE_BUILD_CHANNEL: "a".repeat(21) }), undefined);
  assert.equal(buildInfo({ HIVE_BUILD_CHANNEL: "TEST" }), undefined);
});

test("buildInfo strips terminal escapes and line breaks from the label", () => {
  const info = buildInfo({ HIVE_BUILD_CHANNEL: "test", HIVE_BUILD_LABEL: "a\u001b[2Jb\nc" });
  assert.deepEqual(info, { channel: "test", label: "a[2Jbc" });
  assert.ok(!info.label.includes("\u001b"));
  assert.ok(!info.label.includes("\n"));
});

test("buildInfo cuts a long label to 100 characters", () => {
  const info = buildInfo({ HIVE_BUILD_CHANNEL: "test", HIVE_BUILD_LABEL: "x".repeat(300) });
  assert.equal(info.label, "x".repeat(100));
  assert.equal(info.label.length, 100);
});
