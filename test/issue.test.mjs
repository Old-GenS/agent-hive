// Posting a no-change review as an issue: the body and the gh call (with a fake gh).
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hive-issue-"));
process.env.HIVE_DOTENV_PATH = join(dir, "missing.env");
process.env.FAKE_GH_LOG = join(dir, "gh.log");
process.env.GH_BIN = join(dir, "gh");
writeFileSync(
  process.env.GH_BIN,
  `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_GH_LOG"; done
if [ "$4" = me/off ]; then echo "issues are disabled" >&2; exit 1; fi
echo "https://github.com/me/repo/issues/12"
`,
);
chmodSync(process.env.GH_BIN, 0o755);

const { issueBody, openIssue } = await import("../dist/git.js");

test("issueBody is the write-up plus where the run looked", () => {
  const body = issueBody("## Findings\n- one", { model: "deepseek-flash", baseSha: "0123456789abcdef0123" });
  assert.ok(body.startsWith("## Findings\n- one"));
  assert.match(body, /run on `deepseek-flash` against the default branch at `0123456789ab`/);
  assert.match(issueBody("x", { model: "m", branch: "dev" }), /against branch `dev`\. The run changed no files/);
});

test("openIssue calls gh issue create and returns the issue URL", async () => {
  const url = await openIssue({ slug: "me/repo", title: "hive review: x", body: "text" });
  assert.equal(url, "https://github.com/me/repo/issues/12");
  const args = readFileSync(process.env.FAKE_GH_LOG, "utf8").trim().split("\n");
  assert.deepEqual(args, ["issue", "create", "--repo", "me/repo", "--title", "hive review: x", "--body", "text"]);
});

test("openIssue reports gh's error", async () => {
  await assert.rejects(openIssue({ slug: "me/off", title: "t", body: "b" }), /Couldn't open the issue: issues are disabled/);
});
