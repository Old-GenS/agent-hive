/**
 * Host-side git. Everything here runs with the host's SSH keys, so it only ever touches the
 * pristine clone (<task>/origin), which no sandbox mounts. The sandbox works on a separate copy
 * (<task>/work); its results come back as patch files and are applied here with `git am`, which
 * treats them as data (it refuses paths inside .git and writes through symlinks).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

// Hooks and fsmonitor off for every host git call, belt and braces: the pristine clone never
// receives a hook, but nothing here should ever execute repo-supplied code.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=user"];

export async function git(args: string[], cwd?: string, timeout = 60_000) {
  const { stdout } = await execFileAsync("git", [...SAFE, ...args], {
    cwd,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalise a repo reference to an SSH URL for deploy-key auth. Accepts owner/repo,
 * https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git). Anything else is
 * refused (file paths, other hosts, option-looking strings) unless HIVE_ALLOW_ANY_REPO_URL=1.
 */
export function normalizeRepo(input: string): { url: string; name: string } {
  const s = input.trim();
  let path: string | undefined;
  if (OWNER_REPO.test(s)) path = s;
  const https = s.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (https) path = https[1];
  const ssh = s.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (ssh) path = ssh[1];
  if (path) {
    path = path.replace(/\.git$/, "");
    if (path.split("/").some((part) => part === "." || part === "..")) throw new Error(`Invalid repo: ${input}`);
    return { url: `git@github.com:${path}.git`, name: path.split("/")[1] };
  }
  if (config.git.allowAnyRepoUrl && !s.startsWith("-")) {
    const name = s.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "repo";
    return { url: s, name };
  }
  throw new Error("repo must be owner/name or a github.com URL");
}

export function validateBranch(branch: string): string {
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  return branch;
}

/** Clone into <dir>/origin (host only) and <dir>/work (for the sandbox). Returns the base SHA. */
export async function prepareRepo(dir: string, repoUrl: string, branch?: string): Promise<string> {
  const origin = join(dir, "origin");
  const work = join(dir, "work");
  const args = ["clone", "-q", "--depth", "50"];
  if (branch) args.push("--branch", branch);
  args.push("--", repoUrl, origin);
  await git(args, undefined, 120_000);
  const base = await git(["rev-parse", "HEAD"], origin);

  // --no-hardlinks: the sandbox must not share object files with the pristine clone.
  await git(["clone", "-q", "--no-hardlinks", "--", origin, work], undefined, 120_000);
  await git(["remote", "remove", "origin"], work);
  await git(["config", "user.name", config.git.authorName], work);
  await git(["config", "user.email", config.git.authorEmail], work);
  return base;
}

const MAX_PATCH_BYTES = 50 * 1024 * 1024;
const MAX_PATCHES = 500;

/**
 * Apply the sandbox's patches (from <dir>/out) on top of the base commit in the pristine clone
 * and force-push them to the task's branch. Returns the number of commits pushed (0 = no changes).
 */
export async function applyAndPush(dir: string, base: string, resultBranch: string): Promise<number> {
  const origin = join(dir, "origin");
  const out = join(dir, "out");
  const patches = readdirSync(out).filter((f) => f.endsWith(".patch")).sort();
  if (patches.length === 0) return 0;
  if (patches.length > MAX_PATCHES) throw new Error(`Too many commits to apply (${patches.length})`);
  const total = patches.reduce((n, f) => n + statSync(join(out, f)).size, 0);
  if (total > MAX_PATCH_BYTES) throw new Error(`Changes too large to apply (${total} bytes)`);

  const ident = ["-c", `user.name=${config.git.authorName}`, "-c", `user.email=${config.git.authorEmail}`];
  await git(["checkout", "-q", "-B", resultBranch, base], origin);
  try {
    await git([...ident, "am", "-q", "--keep-cr", ...patches.map((f) => join(out, f))], origin, 120_000);
  } catch (err) {
    await git(["am", "--abort"], origin).catch(() => {});
    throw new Error(`Couldn't apply the agent's commits: ${(err as Error).message}`);
  }
  // The branch belongs to this task, so a follow-up run may rewrite it.
  await git(["push", "-q", "--force", "origin", `HEAD:refs/heads/${resultBranch}`], origin, 120_000);
  return patches.length;
}
