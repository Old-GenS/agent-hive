// src/source-version.ts: how a source checkout names itself ("from source: <sha> on <branch>, N
// commits after vX"), and buildInfo's fallback label that uses it for a dev server's banner.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLabel, sourceDescriptionAt } from "../dist/source-version.js";
import { buildInfo } from "../dist/build-info.js";

const root = mkdtempSync(join(tmpdir(), "hive-source-version-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("describeLabel: commits after a release tag, on a branch", () => {
  assert.equal(describeLabel("v0.5.12-2-g8583551", "main"), "from source: 8583551 on main, 2 commits after v0.5.12");
  assert.equal(describeLabel("v0.5.12-1-g8583551abc", "main"), "from source: 8583551 on main, 1 commit after v0.5.12");
});

test("describeLabel: exactly at a tag, detached, dirty, and no tag at all", () => {
  assert.equal(describeLabel("v0.5.12-0-gd8e1374", "main"), "from source: d8e1374 on main, at v0.5.12");
  assert.equal(describeLabel("v0.5.12-3-gabcdef1", "HEAD"), "from source: abcdef1 (detached), 3 commits after v0.5.12");
  assert.equal(
    describeLabel("v0.5.12-2-g8583551-dirty\n", "feat/x"),
    "from source: 8583551 on feat/x, 2 commits after v0.5.12, with uncommitted changes",
  );
  assert.equal(describeLabel("8583551", "main"), "from source: 8583551 on main");
  assert.equal(describeLabel("8583551-dirty", "main"), "from source: 8583551 on main, with uncommitted changes");
});

test("sourceDescriptionAt reads a real checkout", () => {
  const dir = join(root, "repo");
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  g("config", "tag.gpgsign", "false");
  writeFileSync(join(dir, "f"), "0");
  g("add", "f");
  g("commit", "-q", "-m", "one");
  // No tag yet: just the commit and branch.
  assert.match(sourceDescriptionAt(dir), /^from source: [0-9a-f]{7} on main$/);

  g("tag", "v1.2.3");
  assert.match(sourceDescriptionAt(dir), /^from source: [0-9a-f]{7} on main, at v1\.2\.3$/);

  writeFileSync(join(dir, "f"), "1");
  g("commit", "-q", "-am", "two");
  const sha = g("rev-parse", "--short=7", "HEAD");
  assert.equal(sourceDescriptionAt(dir), `from source: ${sha} on main, 1 commit after v1.2.3`);

  writeFileSync(join(dir, "f"), "2");
  assert.equal(sourceDescriptionAt(dir), `from source: ${sha} on main, 1 commit after v1.2.3, with uncommitted changes`);
});

test("sourceDescriptionAt is undefined outside a git checkout", () => {
  const dir = mkdtempSync(join(root, "plain-"));
  assert.equal(sourceDescriptionAt(dir), undefined);
});

test("buildInfo takes the fallback label only when a channel is set and no label is given", () => {
  const fallback = () => "from source: 8583551 on main";
  assert.deepEqual(buildInfo({ HIVE_BUILD_CHANNEL: "dev" }, fallback), { channel: "dev", label: "from source: 8583551 on main" });
  assert.deepEqual(buildInfo({ HIVE_BUILD_CHANNEL: "test", HIVE_BUILD_LABEL: "test-19" }, fallback), { channel: "test", label: "test-19" });
  assert.equal(buildInfo({}, fallback), undefined);
  assert.deepEqual(buildInfo({ HIVE_BUILD_CHANNEL: "dev" }, () => undefined), { channel: "dev", label: "" });
});
