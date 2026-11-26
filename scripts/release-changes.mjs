#!/usr/bin/env node
/**
 * The "what changed" paragraph of a release's notes: the pull requests merged since the previous
 * stable release, by title. test.yml (test builds) and promote.yml (stable releases) both print it,
 * so the two can never disagree.
 *
 *   node scripts/release-changes.mjs --head <sha> [--since-tag <vX.Y.Z> --since-notes <file>]
 *
 * It counts from the commit the previous release was *tested* on, not from its tag. promote.yml
 * puts the tag on main's head when it runs (a workflow token may not tag an older commit), so a
 * pull request merged between that release's test build and its promotion sits before the tag but
 * was never in the release; counting from the tag would leave it out of every release's notes.
 * The tested commit is in the previous release's own notes ("of commit <sha>", or "built from
 * commit <sha>" in older ones). Without it, the tag is the fallback.
 *
 * Pure parsing is exported for the tests; the CLI runs git with argument arrays, never a shell.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Most entries listed before "...and N more". */
export const MAX_ENTRIES = 40;

/** The tested commit a release's notes name, or undefined. */
export function testedCommitFromNotes(notes) {
  const m = /\bcommit ([0-9a-f]{40})\b/.exec(notes ?? "");
  return m ? m[1] : undefined;
}

/**
 * One line per first-parent commit: a merged pull request as `#<n> <title>` (GitHub writes the
 * title on the merge commit's second line), anything else as `<short sha> <subject>`.
 */
export function changeLines(entries) {
  return entries.map(({ sha, subject, body }) => {
    const pr = /^Merge pull request #(\d+) from /.exec(subject);
    if (pr) {
      const title = (body ?? "").split("\n").map((line) => line.trim()).find(Boolean);
      return `#${pr[1]} ${title ?? subject}`;
    }
    return `${sha.slice(0, 7)} ${subject}`;
  });
}

/** The full paragraph, as markdown. `base` names what it counts from, for the reader. */
export function changesParagraph({ sinceTag, baseLabel, lines }) {
  if (!sinceTag) return "First stable release on this repository.";
  const heading = `Changes since ${sinceTag}${baseLabel ? ` (${baseLabel})` : ""}:`;
  if (lines.length === 0) return `${heading}\n\n(no changes)`;
  const shown = lines.slice(0, MAX_ENTRIES).map((line) => `- ${line}`);
  if (lines.length > MAX_ENTRIES) shown.push(`- ...and ${lines.length - MAX_ENTRIES} more`);
  return `${heading}\n\n${shown.join("\n")}`;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commitExists(rev, cwd) {
  try {
    git(["cat-file", "-e", `${rev}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** First-parent commits in base..head, newest first. */
export function firstParentEntries(base, head, cwd) {
  const out = git(["log", "--first-parent", "--format=%H%x00%s%x00%b%x1e", `${base}..${head}`], cwd);
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, subject, body] = record.split("\x00");
      return { sha, subject, body };
    });
}

/** Everything the CLI does, with git run in `cwd`. */
export function releaseChanges({ head, sinceTag, sinceNotes, cwd = process.cwd() }) {
  if (!sinceTag) return changesParagraph({});
  const tested = testedCommitFromNotes(sinceNotes);
  let base;
  let baseLabel;
  if (tested && commitExists(tested, cwd)) {
    base = tested;
    baseLabel = `its tested commit ${tested.slice(0, 7)}`;
  } else if (commitExists(`refs/tags/${sinceTag}`, cwd)) {
    base = `refs/tags/${sinceTag}`;
    baseLabel = "its tag";
  } else {
    return `Changes since ${sinceTag}: unknown (neither its tested commit nor its tag is in this clone).`;
  }
  return changesParagraph({ sinceTag, baseLabel, lines: changeLines(firstParentEntries(base, head, cwd)) });
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--head") o.head = value;
    else if (flag === "--since-tag") o.sinceTag = value;
    else if (flag === "--since-notes") o.sinceNotes = readFileSync(value, "utf8");
    else throw new Error(`unknown option ${flag}`);
  }
  if (!o.head) throw new Error("--head is required");
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(releaseChanges(parseArgs(process.argv.slice(2))) + "\n");
  } catch (err) {
    process.stderr.write(`release-changes: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
