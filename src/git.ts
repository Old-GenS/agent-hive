/**
 * Host-side git. Everything here runs with the host's git credentials, so it only ever touches the
 * pristine clone (<task>/origin), which no sandbox mounts. The sandbox works on a separate copy
 * (<task>/work); its results come back as patch files and are applied here with `git am`, which
 * treats them as data (it refuses paths inside .git and writes through symlinks).
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readdirSync, statSync } from "node:fs";
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
 * Normalise a repo reference to a github.com URL: https (the host's git credential helper, e.g. a
 * `gh` login) or, with HIVE_GIT_PROTOCOL=ssh, SSH (deploy keys). Accepts owner/repo,
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
    const url = config.git.protocol === "ssh" ? `git@github.com:${path}.git` : `https://github.com/${path}.git`;
    return { url, name: path.split("/")[1] };
  }
  if (config.git.allowAnyRepoUrl && !s.startsWith("-")) {
    const name = s.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "repo";
    return { url: s, name };
  }
  throw new Error("repo must be owner/name or a github.com URL");
}

/**
 * Normalise a repo reference for `hive run --repo` / `hive push`: owner/name becomes a
 * github.com https URL; https://, http://, ssh:// and scp-like URLs are kept as given. Option
 * looking strings and plain paths are refused.
 */
export function normalizeCliRepo(input: string): { url: string; name: string } {
  const s = input.trim();
  if (s.startsWith("-")) throw new Error("repo must be owner/name or a git URL");
  let url: string;
  if (OWNER_REPO.test(s)) {
    url = `https://github.com/${s}.git`;
  } else if (/^(?:https?|ssh):\/\//.test(s) || /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(s)) {
    url = s;
  } else {
    throw new Error("repo must be owner/name or a git URL");
  }
  url = url.replace(/\/+$/, "");
  const name = url.split(/[/:]/).filter((part) => part !== "").pop()?.replace(/\.git$/, "") || "repo";
  return { url, name };
}

/** `owner/name` for a github.com URL (https, ssh:// or scp-like), without `.git`; else undefined. */
export function githubSlug(url: string): string | undefined {
  const s = url.trim();
  const patterns = [
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return undefined;
}

/** The user's own git identity from `cwd`; a missing or failing config leaves the field unset. */
export function gitConfigIdentity(cwd: string): { name?: string; email?: string } {
  const read = (key: string): string | undefined => {
    try {
      const value = execFileSync("git", ["config", "--get", key], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  };
  return { name: read("user.name"), email: read("user.email") };
}

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** Validate a name for a repository created from scratch; returns it trimmed. */
export function validateRepoName(name: string): string {
  const trimmed = name.trim();
  if (
    !REPO_NAME.test(trimmed) ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("-") ||
    trimmed.endsWith(".git") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new Error("Project name may only use letters, digits, '-', '_' and '.' (max 100)");
  }
  return trimmed;
}

/** The gh binary; read per call so tests can point GH_BIN at a fake. */
function ghBin(): string {
  return process.env.GH_BIN || "gh";
}

const GH_ENV = () => ({ ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" });

/** The logged-in GitHub account name (`gh api user`). */
export async function githubLogin(): Promise<string> {
  let login: string;
  try {
    const { stdout } = await execFileAsync(ghBin(), ["api", "user", "--jq", ".login"], {
      env: GH_ENV(),
      timeout: 30_000,
    });
    login = stdout.trim();
  } catch {
    throw new Error("Couldn't read the GitHub login (gh auth status)");
  }
  if (!login || !/^[A-Za-z0-9-]+$/.test(login)) {
    throw new Error("Couldn't read the GitHub login (gh auth status)");
  }
  return login;
}

/** Create <login>/<name> on GitHub with `gh repo create`; returns the `owner/name` slug. */
export async function createGithubRepo(name: string, isPrivate: boolean): Promise<string> {
  const repoName = validateRepoName(name);
  const owner = await githubLogin();
  const full = `${owner}/${repoName}`;
  const args = [
    "repo",
    "create",
    full,
    isPrivate ? "--private" : "--public",
    "--description",
    "Created by agent-hive",
  ];
  try {
    await execFileAsync(ghBin(), args, { env: GH_ENV(), timeout: 60_000 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = String(e.stderr || e.message || "").trim().slice(-500);
    throw new Error(`Couldn't create the GitHub repository ${full}: ${detail}`);
  }
  return full;
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

/**
 * Set up a brand-new project at <dir>: an empty `main` repo in <dir>/origin (the host's pristine
 * copy, which receives the push) and the sandbox's copy in <dir>/work. Returns the base SHA.
 */
export async function prepareNewRepo(dir: string): Promise<string> {
  const origin = join(dir, "origin");
  const work = join(dir, "work");
  mkdirSync(origin, { recursive: true });
  await git(["init", "-q", "-b", "main"], origin);
  await git(
    [
      "-c",
      "user.name=" + config.git.authorName,
      "-c",
      "user.email=" + config.git.authorEmail,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Initial commit",
    ],
    origin,
  );
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
export async function applyAndPush(
  dir: string,
  base: string,
  resultBranch: string,
  force = true,
): Promise<number> {
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
  const push = force ? ["push", "-q", "--force"] : ["push", "-q"];
  await git([...push, "origin", `HEAD:refs/heads/${resultBranch}`], origin, 120_000);
  return patches.length;
}

export interface ChangeSummary {
  commits: string[];
  files: { path: string; added: number | null; removed: number | null }[];
  /** more files changed than are listed */
  moreFiles: number;
}

const MAX_SUMMARY_FILES = 200;

/**
 * What the pushed commits changed, read from the pristine clone (never from work/): commit
 * subjects oldest first, and per-file lines added/removed (null for binary files).
 */
export async function changeSummary(dir: string, base: string): Promise<ChangeSummary> {
  const origin = join(dir, "origin");
  const log = await git(["log", "--reverse", "--format=%s", `${base}..HEAD`], origin);
  const commits = log ? log.split("\n") : [];
  const numstat = await git(["diff", "--numstat", "--no-renames", base, "HEAD"], origin);
  const all = numstat
    ? numstat.split("\n").map((line) => {
        const [a, r, ...rest] = line.split("\t");
        return {
          path: rest.join("\t"),
          added: a === "-" ? null : Number.parseInt(a, 10),
          removed: r === "-" ? null : Number.parseInt(r, 10),
        };
      })
    : [];
  return { commits, files: all.slice(0, MAX_SUMMARY_FILES), moreFiles: Math.max(0, all.length - MAX_SUMMARY_FILES) };
}

// ── CLI host-side git ──
// These run against the user's own repo (rev-parse, status, clone source, apply/am of exported
// patches), never against a run's work/ copy.

/** Absolute top of the work tree containing `cwd`. */
export async function repoTop(cwd: string): Promise<string> {
  try {
    return await git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new Error("not in a git repo");
  }
}

/** True when `repo` has staged, unstaged or untracked changes. */
export async function isDirty(repo: string): Promise<boolean> {
  return (await git(["status", "--porcelain"], repo)) !== "";
}

/** Clone `repo` at HEAD into `work` (no hardlinks, no remote) and return the base SHA. */
export async function prepareLocal(repo: string, work: string): Promise<string> {
  const base = await git(["rev-parse", "HEAD"], repo);
  await git(["clone", "-q", "--no-hardlinks", "--", repo, work], undefined, 120_000);
  await git(["remote", "remove", "origin"], work);
  await git(["config", "user.name", config.git.authorName], work);
  await git(["config", "user.email", config.git.authorEmail], work);
  return base;
}

/** Commits made in the sandbox use the configured identity (env beats git config). */
export function gitIdentity(): Record<string, string> {
  const { authorName, authorEmail } = config.git;
  return {
    GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail,
  };
}
