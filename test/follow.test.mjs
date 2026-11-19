// followJsonl must not follow a symlink the VM put in its /io folder onto a host file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { followJsonl } = await import("../dist/follow.js");

test("followJsonl ignores a symlinked events file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-follow-link-"));
  const secret = join(dir, "host-file.jsonl");
  writeFileSync(secret, '{"type":"secret"}\n');
  const link = join(dir, "events.jsonl");
  symlinkSync(secret, link);
  const events = [];
  const follower = followJsonl(link, (e) => events.push(e), 60_000);
  follower.poll();
  follower.stop();
  assert.deepEqual(events, []);
});
