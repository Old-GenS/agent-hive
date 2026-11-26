/**
 * What a source checkout is running, in words: "from source: 8583551 on main, 2 commits after
 * v0.5.12". A release reads its own VERSION file instead; this is only for running from a clone,
 * where package.json's version is not a release number (test.yml works that out at build time, so
 * package.json is never bumped and would name a release from long ago).
 *
 * It asks git about hive's own checkout (the directory above dist/), never a user's repo or a run's
 * work/ folder. Computed once per process: a dev server is restarted after a rebuild anyway.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The checkout this module was built in: dist/source-version.js -> the repo root. */
const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Words for `git describe --tags --match 'v[0-9]*' --long --always --dirty` output and the branch
 * (`git rev-parse --abbrev-ref HEAD`; "HEAD" when detached). Pure.
 */
export function describeLabel(describe: string, branch: string): string {
  let text = describe.trim();
  const dirty = text.endsWith("-dirty");
  if (dirty) text = text.slice(0, -"-dirty".length);
  const where = branch && branch !== "HEAD" ? ` on ${branch}` : " (detached)";
  const changes = dirty ? ", with uncommitted changes" : "";

  const m = /^(v\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)$/.exec(text);
  if (m) {
    const [, tag, count, sha] = m;
    const n = Number(count);
    const since = n === 0 ? `at ${tag}` : `${n} commit${n === 1 ? "" : "s"} after ${tag}`;
    return `from source: ${sha.slice(0, 7)}${where}, ${since}${changes}`;
  }
  // No release tag in this clone: --always printed the bare commit.
  return `from source: ${text.slice(0, 7)}${where}${changes}`;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  }).trim();
}

/** The label for a checkout at `dir`, or undefined when it is not a git checkout or git is missing. */
export function sourceDescriptionAt(dir: string): string | undefined {
  try {
    const describe = git(["describe", "--tags", "--match", "v[0-9]*", "--long", "--always", "--dirty"], dir);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    return describe ? describeLabel(describe, branch) : undefined;
  } catch {
    return undefined;
  }
}

let cached: { value: string | undefined } | undefined;

/** The label for hive's own checkout, computed once. */
export function sourceDescription(): string | undefined {
  cached ??= { value: sourceDescriptionAt(CHECKOUT) };
  return cached.value;
}
