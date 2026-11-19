// Pull requests from a run: the description and the gh call (with a fake gh).
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hive-pr-"));
process.env.HIVE_DOTENV_PATH = join(dir, "missing.env");
process.env.FAKE_GH_LOG = join(dir, "gh.log");
process.env.GH_BIN = join(dir, "gh");
writeFileSync(
  process.env.GH_BIN,
  `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_GH_LOG"; done
if [ "$6" = hive/bad ]; then echo "a pull request already exists" >&2; exit 1; fi
echo "https://github.com/me/repo/pull/7"
`,
);
chmodSync(process.env.GH_BIN, 0o755);

const { prBody, openPullRequest } = await import("../dist/git.js");

test("prBody puts the agent's write-up first, then commits and files from git", () => {
  const body = prBody(
    "## Review\nLooks fine.",
    {
      commits: ["Fix a", "Add b"],
      files: [
        { path: "a|b.txt", added: 2, removed: 1 },
        { path: "logo.png", added: null, removed: null },
      ],
      moreFiles: 0,
    },
    "deepseek-flash",
  );
  assert.ok(body.startsWith("## Review\nLooks fine."));
  assert.match(body, /### Commits\n- Fix a\n- Add b/);
  assert.match(body, /\| `a\\\|b\.txt` \| \+2 \| −1 \|/);
  assert.match(body, /\| `logo\.png` \| binary \| \|/);
  assert.match(body, /Opened by agent-hive from a run on `deepseek-flash`/);
  assert.match(prBody("", undefined, "m"), /The agent left no summary/);
});

test("openPullRequest calls gh pr create and returns the PR URL", async () => {
  const url = await openPullRequest({ slug: "me/repo", branch: "hive/abc", title: "hive: review", body: "text" });
  assert.equal(url, "https://github.com/me/repo/pull/7");
  const args = readFileSync(process.env.FAKE_GH_LOG, "utf8").trim().split("\n");
  assert.deepEqual(args, ["pr", "create", "--repo", "me/repo", "--head", "hive/abc", "--title", "hive: review", "--body", "text"]);
});

test("openPullRequest reports gh's error", async () => {
  await assert.rejects(
    openPullRequest({ slug: "me/repo", branch: "hive/bad", title: "t", body: "b" }),
    /Couldn't open the pull request: a pull request already exists/,
  );
});
