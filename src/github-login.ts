/**
 * GitHub device login for the server: the `hive login github` flow, but started from the web UI
 * and shown on the page.
 *
 * `gh auth login --web` prints a one-time code and waits for Enter (newer versions) before it
 * starts polling GitHub. This module spawns it, passes the Enter for it, reads the code from its
 * output, and keeps polling in the background; the page shows the code and the link while the
 * person enters the code on GitHub. One login at a time for this server process.
 *
 * The output is never logged. It is only searched for the code; the code is not secret, and gh
 * prints no tokens here.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { githubLogin } from "./git.js";

const execFileAsync = promisify(execFile);

/** `1A2B-3C4D`, the one-time code gh prints before it starts waiting. */
const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
/** gh's device login page, as printed next to the code. */
const DEVICE_URL_RE = /https:\/\/github\.com\/login\/device\b/;
const DEVICE_URL = "https://github.com/login/device";

export type GithubLoginState =
  | { state: "idle" }
  | { state: "starting"; startedAt: number }
  | { state: "waiting"; code: string; url: string; startedAt: number }
  | { state: "done"; login: string }
  | { state: "error"; error: string };

/** How long to wait for the code, and for the whole login. Read at start; tests shorten it. */
interface LoginTimeouts {
  codeMs: number;
  maxMs: number;
}

let timeouts: LoginTimeouts = { codeMs: 20_000, maxMs: 15 * 60_000 };

/** Shorten the limits; tests use this, production keeps 20 s for the code and 15 min in total. */
export function setGithubLoginTimeouts(next: Partial<LoginTimeouts>): void {
  timeouts = { ...timeouts, ...next };
}

/** The gh binary; read per call so tests can point GH_BIN at a fake. */
function ghBin(): string {
  return process.env.GH_BIN || "gh";
}

/**
 * The token's scopes from `gh auth status` output: the `Token scopes: 'gist', 'read:org', 'repo'`
 * line (quotes optional), or undefined when there is no such line. Fine-grained tokens print no
 * scope line, and that is unknown rather than missing.
 */
export function parseScopes(statusText: string): string[] | undefined {
  const line = /^[ \t]*(?:-[ \t]*)?Token scopes:[ \t]*(.*)$/im.exec(statusText);
  if (!line) return undefined;
  return line[1]
    .split(",")
    .map((scope) => scope.trim().replace(/^(['"])(.*)\1$/, "$2").trim())
    .filter(Boolean);
}

/** The scopes of the server's gh token, or undefined when gh is missing, not logged in or prints none. */
export async function githubScopes(): Promise<string[] | undefined> {
  try {
    // gh prints `auth status` to stderr on some versions, so read both streams.
    const { stdout, stderr } = await execFileAsync(ghBin(), ["auth", "status", "--hostname", "github.com"], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseScopes(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

/** `1A2B-3C4D` and the device URL from gh's output, or undefined while there is no code yet. */
export function parseDeviceCode(text: string): { code: string; url: string } | undefined {
  const code = CODE_RE.exec(text);
  if (!code) return undefined;
  const url = DEVICE_URL_RE.exec(text);
  return { code: code[1], url: url ? url[0] : DEVICE_URL };
}

let current: GithubLoginState = { state: "idle" };
let child: ChildProcess | null = null;
let startPromise: Promise<GithubLoginState> | null = null;
let resolveStart: ((state: GithubLoginState) => void) | null = null;
let startSettled = true;
/** The last part of gh's output, kept only to find the code and to explain an error. */
let output = "";
let codeTimer: ReturnType<typeof setTimeout> | undefined;
let maxTimer: ReturnType<typeof setTimeout> | undefined;

/** The current login state (`{ state: "idle" }` when no login has been started). */
export function githubLoginState(): GithubLoginState {
  return current;
}

/** Resolve the promise `startGithubLogin` returned, once. Later calls just update the state. */
function settleStart(state: GithubLoginState): void {
  current = state;
  if (startSettled) return;
  startSettled = true;
  const resolve = resolveStart;
  resolveStart = null;
  resolve?.(state);
}

function clearTimers(): void {
  if (codeTimer !== undefined) clearTimeout(codeTimer);
  if (maxTimer !== undefined) clearTimeout(maxTimer);
  codeTimer = undefined;
  maxTimer = undefined;
}

/** Kill the running gh, if any; its close/error handlers then see it is no longer ours. */
function stopChild(): void {
  const proc = child;
  child = null;
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    // Already gone.
  }
}

/** An error state carrying the last 500 characters of gh's output (no secrets are printed there). */
function failure(message: string): GithubLoginState {
  const tail = output.trim().slice(-500);
  output = "";
  return { state: "error", error: tail ? `${message}: ${tail}` : message };
}

/** Finish for good: timers off, process gone, state final. */
function finish(state: GithubLoginState): void {
  clearTimers();
  stopChild();
  output = "";
  settleStart(state);
}

/** On a successful exit, `gh auth setup-git` (best effort) and the account name. */
async function completeLogin(): Promise<void> {
  const proc = child;
  try {
    await execFileAsync(ghBin(), ["auth", "setup-git"], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      timeout: 30_000,
    });
  } catch {
    // Best effort: the login worked, and git can still use its own credential helper.
  }
  if (child !== proc) return; // cancelled while setting git up
  try {
    finish({ state: "done", login: await githubLogin() });
  } catch (err) {
    finish(failure(`signed in, but couldn't read the GitHub login: ${err instanceof Error ? err.message : String(err)}`));
  }
}

function runLogin(startedAt: number, refresh: boolean): void {
  // Only flags old gh has too (Ubuntu 24.04 ships 2.45, without --skip-ssh-key); with
  // --git-protocol https gh never asks about SSH keys anyway.
  // --scopes workflow: runs often add CI files, and GitHub refuses pushes touching
  // .github/workflows from a login without that scope. A refresh adds it to the existing login.
  const args = refresh
    ? ["auth", "refresh", "--hostname", "github.com", "--scopes", "workflow"]
    : ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "workflow"];
  // BROWSER=true stops gh opening a browser on the server; the person opens the link themselves.
  const proc = spawn(ghBin(), args, {
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", BROWSER: "true" },
  });
  child = proc;
  let sawCode = false;
  let wroteEnter = false;

  // gh may exit before we write; the pipe error must not crash the server.
  proc.stdin.on("error", () => {});
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  const onData = (chunk: string): void => {
    output = (output + chunk).slice(-4000);
    if (sawCode) return;
    const parsed = parseDeviceCode(output);
    if (!parsed) return;
    sawCode = true;
    if (codeTimer !== undefined) {
      clearTimeout(codeTimer);
      codeTimer = undefined;
    }
    if (!wroteEnter) {
      wroteEnter = true;
      // Newer gh waits for Enter before it starts polling; older versions don't mind it.
      try {
        proc.stdin.write("\n");
        proc.stdin.end();
      } catch {
        // gh already closed its stdin.
      }
    }
    settleStart({ state: "waiting", code: parsed.code, url: parsed.url, startedAt });
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  codeTimer = setTimeout(() => {
    if (sawCode) return;
    finish(failure("the GitHub login didn't show a one-time code"));
  }, timeouts.codeMs);
  maxTimer = setTimeout(() => {
    finish({ state: "error", error: "timed out" });
  }, timeouts.maxMs);

  proc.on("error", (err: NodeJS.ErrnoException) => {
    if (child !== proc) return;
    finish(
      failure(
        err.code === "ENOENT"
          ? "gh is not installed on this computer. Install the GitHub CLI (gh)"
          : `couldn't start gh: ${err.message}`,
      ),
    );
  });

  proc.on("close", (code) => {
    if (child !== proc) return;
    clearTimers();
    if (code === 0) {
      void completeLogin();
      return;
    }
    finish(failure(`the GitHub login failed (gh exited with code ${code ?? "unknown"})`));
  });
}

/**
 * Start gh's device login (or, with `refresh: true`, `gh auth refresh` for the workflow scope), or
 * join the one already in progress. Only one flow runs at a time. The promise resolves when there
 * is something to show (a code: `waiting`) or when the flow ended (`done` / `error`); a flow that
 * got its code keeps running in the background and its state is available from
 * `githubLoginState()`.
 */
export function startGithubLogin(o: { refresh?: boolean } = {}): Promise<GithubLoginState> {
  if (child) {
    if (!startSettled && startPromise) return startPromise;
    return Promise.resolve(current);
  }
  startSettled = false;
  output = "";
  const startedAt = Date.now();
  current = { state: "starting", startedAt };
  startPromise = new Promise<GithubLoginState>((resolve) => {
    resolveStart = resolve;
  });
  runLogin(startedAt, o.refresh === true);
  return startPromise;
}

/** Kill a pending login and go back to idle. */
export function cancelGithubLogin(): void {
  clearTimers();
  stopChild();
  output = "";
  settleStart({ state: "idle" });
}
