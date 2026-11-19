// changeSummary reads what the pushed commits changed from the pristine clone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

process.env.HIVE_DOTENV_PATH = join(mkdtempSync(join(tmpdir(), "hive-changes-env-")), "missing.env");
const { changeSummary } = await import("../dist/git.js");

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("changeSummary lists commit subjects and per-file line counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-changes-"));
  const origin = join(dir, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "one\ntwo\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "base");
  const base = git(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "a.txt"), "one\nTWO\nthree\n");
  git(origin, "commit", "-q", "-am", "Edit a");
  writeFileSync(join(origin, "b.bin"), Buffer.from([0, 1, 2, 0, 255]));
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "Add b");

  const summary = await changeSummary(dir, base);
  assert.deepEqual(summary.commits, ["Edit a", "Add b"]);
  assert.deepEqual(summary.files, [
    { path: "a.txt", added: 2, removed: 1 },
    { path: "b.bin", added: null, removed: null },
  ]);
  assert.equal(summary.moreFiles, 0);
});
