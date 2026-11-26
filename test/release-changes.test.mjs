// scripts/release-changes.mjs: the "Changes since vX" paragraph test.yml and promote.yml print.
// The git tests build a real repository shaped like this repo's history: merge commits from pull
// requests, and a release tag on main's head *after* the tested commit, the way promote.yml tags.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_ENTRIES,
  changeLines,
  changesParagraph,
  releaseChanges,
  testedCommitFromNotes,
} from "../scripts/release-changes.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "hive-release-changes-"));
after(() => rmSync(root, { recursive: true, force: true }));

const SHA_A = "a".repeat(40);

test("testedCommitFromNotes reads promote's wording and the older one", () => {
  assert.equal(testedCommitFromNotes(`Promoted from the test build \`test-17-0.5.12\` of commit ${SHA_A}, which`), SHA_A);
  assert.equal(testedCommitFromNotes(`Promoted from test build test-12-0.5.10, built from commit ${SHA_A} and booted`), SHA_A);
  assert.equal(testedCommitFromNotes("no commit here"), undefined);
  assert.equal(testedCommitFromNotes(undefined), undefined);
});

test("changeLines names merged pull requests by title and other commits by subject", () => {
  assert.deepEqual(
    changeLines([
      { sha: "1".repeat(40), subject: "Merge pull request #43 from o/deps/node-26", body: "Move the bundled Node to 26\n" },
      { sha: "2".repeat(40), subject: "Merge pull request #7 from o/x", body: "" },
      { sha: "3".repeat(40), subject: "A direct commit", body: "" },
    ]),
    ["#43 Move the bundled Node to 26", "#7 Merge pull request #7 from o/x", "3333333 A direct commit"],
  );
});

test("changesParagraph: first release, no changes, and a long list", () => {
  assert.equal(changesParagraph({}), "First stable release on this repository.");
  assert.equal(changesParagraph({ sinceTag: "v1.0.0", baseLabel: "its tag", lines: [] }), "Changes since v1.0.0 (its tag):\n\n(no changes)");
  const many = Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => `#${i} t`);
  const text = changesParagraph({ sinceTag: "v1.0.0", lines: many });
  assert.match(text, /^Changes since v1\.0\.0:\n\n- #0 t\n/);
  assert.match(text, /\n- \.\.\.and 3 more$/);
});

// A repository: PR #1, the commit v1.0.0 was tested on; PR #2 merged after that test build but
// before promotion; the v1.0.0 tag on that later head (as promote.yml tags); then PR #3.
function makeRepo() {
  const dir = join(root, "repo");
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  g("config", "tag.gpgsign", "false");
  writeFileSync(join(dir, "f"), "0");
  g("add", "f");
  g("commit", "-q", "-m", "start");
  const merge = (n, title) => {
    g("switch", "-q", "-c", `b${n}`);
    writeFileSync(join(dir, `f${n}`), String(n));
    g("add", `f${n}`);
    g("commit", "-q", "-m", `work ${n}`);
    g("switch", "-q", "main");
    g("merge", "-q", "--no-ff", `b${n}`, "-m", `Merge pull request #${n} from o/b${n}`, "-m", title);
    return g("rev-parse", "HEAD");
  };
  const tested = merge(1, "First change");
  merge(2, "Merged between test build and promote");
  g("tag", "v1.0.0");
  const head = merge(3, "After the release");
  return { dir, tested, head };
}

const repo = makeRepo();

test("counts from the tested commit, so a change merged before the tag but after the test build is listed", () => {
  const text = releaseChanges({
    head: repo.head,
    sinceTag: "v1.0.0",
    sinceNotes: `Promoted from the test build \`test-1-1.0.0\` of commit ${repo.tested}, which was booted`,
    cwd: repo.dir,
  });
  assert.equal(
    text,
    `Changes since v1.0.0 (its tested commit ${repo.tested.slice(0, 7)}):\n\n` +
      "- #3 After the release\n- #2 Merged between test build and promote",
  );
});

test("falls back to the tag when the notes name no commit", () => {
  const text = releaseChanges({ head: repo.head, sinceTag: "v1.0.0", sinceNotes: "no commit", cwd: repo.dir });
  assert.equal(text, "Changes since v1.0.0 (its tag):\n\n- #3 After the release");
});

test("falls back to the tag when the named commit is not in the clone", () => {
  const text = releaseChanges({
    head: repo.head,
    sinceTag: "v1.0.0",
    sinceNotes: `of commit ${"b".repeat(40)}`,
    cwd: repo.dir,
  });
  assert.equal(text, "Changes since v1.0.0 (its tag):\n\n- #3 After the release");
});

test("says so when neither the tested commit nor the tag is known", () => {
  const text = releaseChanges({ head: repo.head, sinceTag: "v9.9.9", sinceNotes: "", cwd: repo.dir });
  assert.match(text, /^Changes since v9\.9\.9: unknown/);
});

test("no previous release: the first stable release", () => {
  assert.equal(releaseChanges({ head: repo.head, cwd: repo.dir }), "First stable release on this repository.");
});

test("the CLI prints the paragraph", () => {
  const notes = join(root, "notes.md");
  writeFileSync(notes, `of commit ${repo.tested}`);
  const out = execFileSync(
    process.execPath,
    [join(repoRoot, "scripts/release-changes.mjs"), "--head", repo.head, "--since-tag", "v1.0.0", "--since-notes", notes],
    { cwd: repo.dir, encoding: "utf8" },
  );
  assert.match(out, /^Changes since v1\.0\.0 \(its tested commit [0-9a-f]{7}\):\n\n- #3 After the release\n- #2 /);
});
