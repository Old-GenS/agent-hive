// How a CLI run's outcome is decided: abort, stall, time limit, exit code, then pi's stop reason.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point config at throwaway paths before dist/ is imported, so no real keys file is read.
const dir = mkdtempSync(join(tmpdir(), "hive-run-status-"));
process.env.HIVE_DOTENV_PATH = join(dir, "missing.env");
process.env.HIVE_KEYS_FILE = join(dir, "missing-keys");

const { finalStatus, isTransientModelError } = await import("../dist/runs.js");

/** A clean, successful run; each test overrides just the field it is about. */
const ok = {
  aborted: false,
  timedOut: false,
  stalled: false,
  code: 0,
  stopReason: undefined,
  modelError: undefined,
  stderr: "",
  timeoutMin: 60,
  stallMin: 15,
};

test("aborted run is aborted", () => {
  assert.deepEqual(finalStatus({ ...ok, aborted: true }), { status: "aborted" });
});

test("stalled run failed with the stall time", () => {
  assert.deepEqual(finalStatus({ ...ok, stalled: true }), {
    status: "failed",
    error: "stalled: nothing changed for 15 minutes",
  });
});

test("timed out run failed with the time limit", () => {
  assert.deepEqual(finalStatus({ ...ok, timedOut: true }), {
    status: "failed",
    error: "timed out after 60 minutes",
  });
});

test("non-zero exit failed with the stderr tail", () => {
  assert.deepEqual(finalStatus({ ...ok, code: 2, stderr: "boom\n" }), {
    status: "failed",
    error: "agent exited 2: boom\n",
  });
});

test("stderr is cut to its last 2000 characters", () => {
  const stderr = "x".repeat(3000);
  const result = finalStatus({ ...ok, code: 1, stderr });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "agent exited 1: " + "x".repeat(2000));
});

test("assistant stopReason error failed with the model error", () => {
  assert.deepEqual(finalStatus({ ...ok, stopReason: "error", modelError: "rate limited" }), {
    status: "failed",
    error: "model error: rate limited",
  });
});

test("assistant stopReason aborted failed, using the stop reason when there is no model error", () => {
  assert.deepEqual(finalStatus({ ...ok, stopReason: "aborted" }), {
    status: "failed",
    error: "model error: aborted",
  });
});

test("a normal exit with a normal stop reason is done", () => {
  assert.deepEqual(finalStatus({ ...ok, stopReason: "endTurn" }), { status: "done" });
});

test("disk watchdog failure failed with its reason", () => {
  assert.deepEqual(finalStatus({ ...ok, diskError: "stopped: the run used more than 20 GB of disk" }), {
    status: "failed",
    error: "stopped: the run used more than 20 GB of disk",
  });
});

test("aborted wins over the disk watchdog", () => {
  assert.deepEqual(finalStatus({ ...ok, aborted: true, diskError: "stopped: no disk left" }), { status: "aborted" });
});

test("the disk watchdog wins over stalled and timed out", () => {
  assert.deepEqual(
    finalStatus({ ...ok, diskError: "stopped: no disk left", stalled: true, timedOut: true }),
    { status: "failed", error: "stopped: no disk left" },
  );
});

test("aborted wins over stalled", () => {
  assert.deepEqual(finalStatus({ ...ok, aborted: true, stalled: true, timedOut: true }), { status: "aborted" });
});

test("stalled wins over timed out", () => {
  assert.deepEqual(finalStatus({ ...ok, stalled: true, timedOut: true }), {
    status: "failed",
    error: "stalled: nothing changed for 15 minutes",
  });
});

test("isTransientModelError spots a dropped connection, not a refusal", () => {
  assert.equal(isTransientModelError("UND_ERR_SOCKET: other side closed"), true);
  assert.equal(isTransientModelError("other side closed"), true);
  assert.equal(isTransientModelError("401 Unauthorized"), false);
  assert.equal(isTransientModelError("context length exceeded"), false);
  assert.equal(isTransientModelError(undefined), false);
});

test("a transient model error says the connection dropped and suggests continuing", () => {
  const result = finalStatus({ ...ok, stopReason: "error", modelError: "other side closed (UND_ERR_SOCKET)" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /closed the connection/);
  assert.match(result.error, /Continue the run/);
});

test("a 401 model error keeps the old wording", () => {
  const result = finalStatus({ ...ok, stopReason: "error", modelError: "401 Unauthorized" });
  assert.deepEqual(result, { status: "failed", error: "model error: 401 Unauthorized" });
});
