// The server's GitHub device login: parsing gh's code, the states of a login around a fake `gh`,
// and the three routes. No real gh and no network: GH_BIN points at a shell script.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const root = mkdtempSync(join(tmpdir(), "hive-github-login-"));
const fakeGh = join(root, "gh");
writeFileSync(
  fakeGh,
  `#!/bin/sh
# A fake gh for test/github-login.test.mjs. FAKE_GH_MODE picks the auth-login behaviour.
[ -n "$FAKE_GH_LOG" ] && echo "$@" >> "$FAKE_GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  case "$FAKE_GH_MODE" in
    fail)
      echo "! First copy your one-time code: 1A2B-3C4D"
      echo "Press Enter to open https://github.com/login/device in your browser..."
      sleep 0.1
      exit 1
      ;;
    nocode)
      sleep 5
      exit 1
      ;;
    cancel)
      echo "! First copy your one-time code: 1A2B-3C4D"
      echo "Open this URL to continue in your web browser: https://github.com/login/device"
      read -r _line
      sleep 5
      exit 0
      ;;
    *)
      echo "! First copy your one-time code: 1A2B-3C4D"
      echo "Press Enter to open https://github.com/login/device in your browser..."
      read -r _line
      sleep 0.5
      exit 0
      ;;
  esac
fi
if [ "$1" = "auth" ] && [ "$2" = "refresh" ]; then
  # The workflow-scope refresh: the same device code and Enter prompt as a login.
  echo "! First copy your one-time code: 1A2B-3C4D"
  echo "Press Enter to open https://github.com/login/device in your browser..."
  read -r _line
  sleep 0.5
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  case "$FAKE_GH_STATUS" in
    workflow)
      echo "github.com"
      echo "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'"
      exit 0
      ;;
    stderr)
      # Some gh versions print the status to stderr.
      echo "  - Token scopes: gist, read:org, repo" >&2
      exit 0
      ;;
    finegrained)
      echo "github.com"
      echo "  ✓ Logged in to github.com account octo (keyring)"
      exit 0
      ;;
    loggedout)
      echo "You are not logged into any GitHub hosts. Run gh auth login to authenticate." >&2
      exit 1
      ;;
    *)
      exit 0
      ;;
  esac
fi
if [ "$1" = "auth" ] && [ "$2" = "setup-git" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "octo"
  exit 0
fi
exit 0
`,
);
chmodSync(fakeGh, 0o755);

// Fixed before any dist/ import: config.ts captures the starting environment at import time, and
// the routes' repo helper reads GH_BIN then. github-login.ts reads GH_BIN on every call.
process.env.GH_BIN = fakeGh;
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
process.env.HIVE_KEYS_FILE = join(root, "missing-keys");
process.env.HIVE_RUNS_DIR = join(root, "runs");

const { parseDeviceCode, parseScopes, githubScopes, startGithubLogin, githubLoginState, cancelGithubLogin, setGithubLoginTimeouts } =
  await import("../dist/github-login.js");
const { default: githubRoutes } = await import("../dist/routes/github.js");

/** Wait until predicate() is true (the login finishes in the background). */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the login state");
}

const CODE_LINE = "! First copy your one-time code: 1A2B-3C4D";

test("parseDeviceCode reads gh's two output shapes, the URL, and no code", () => {
  assert.deepEqual(parseDeviceCode(`${CODE_LINE}\nPress Enter to open https://github.com/login/device in your browser...`), {
    code: "1A2B-3C4D",
    url: "https://github.com/login/device",
  });
  assert.deepEqual(
    parseDeviceCode(`${CODE_LINE}\nOpen this URL to continue in your web browser: https://github.com/login/device`),
    { code: "1A2B-3C4D", url: "https://github.com/login/device" },
  );
  // A code without the URL still gets the device page to open.
  assert.deepEqual(parseDeviceCode("your one-time code: WXYZ-9876"), {
    code: "WXYZ-9876",
    url: "https://github.com/login/device",
  });
  assert.equal(parseDeviceCode("! Something went wrong\nTry again later."), undefined);
});

test("device login: the code arrives, a second start joins it, then the login is done", async () => {
  process.env.FAKE_GH_MODE = "ok";
  cancelGithubLogin();

  const state = await startGithubLogin();
  assert.equal(state.state, "waiting");
  assert.equal(state.code, "1A2B-3C4D");
  assert.equal(state.url, "https://github.com/login/device");

  const again = await startGithubLogin();
  assert.deepEqual(again, state);

  await waitFor(() => githubLoginState().state === "done");
  assert.deepEqual(githubLoginState(), { state: "done", login: "octo" });
});

test("device login: a non-zero gh exit leaves an error with its output", async () => {
  process.env.FAKE_GH_MODE = "fail";
  cancelGithubLogin();

  await startGithubLogin();
  await waitFor(() => githubLoginState().state === "error");
  const state = githubLoginState();
  assert.equal(state.state, "error");
  assert.match(state.error, /GitHub login failed/);
  assert.match(state.error, /1A2B-3C4D/);
});

test("device login: no code within the timeout is an error", async () => {
  process.env.FAKE_GH_MODE = "nocode";
  setGithubLoginTimeouts({ codeMs: 300 });
  cancelGithubLogin();
  try {
    const state = await startGithubLogin();
    assert.equal(state.state, "error");
    assert.match(state.error, /one-time code/);
  } finally {
    setGithubLoginTimeouts({ codeMs: 20_000 });
  }
});

test("device login: a missing gh is a clear error", async () => {
  const saved = process.env.GH_BIN;
  process.env.GH_BIN = join(root, "no-such-gh");
  cancelGithubLogin();
  try {
    const state = await startGithubLogin();
    assert.equal(state.state, "error");
    assert.match(state.error, /gh is not installed on this computer/);
    assert.match(state.error, /GitHub CLI/);
  } finally {
    process.env.GH_BIN = saved;
  }
});

test("cancel kills a pending login and resets to idle", async () => {
  process.env.FAKE_GH_MODE = "cancel";
  cancelGithubLogin();
  const state = await startGithubLogin();
  assert.equal(state.state, "waiting");
  cancelGithubLogin();
  assert.deepEqual(githubLoginState(), { state: "idle" });
});

test("routes: POST starts the login, GET reports it, DELETE cancels it", async () => {
  process.env.FAKE_GH_MODE = "ok";
  cancelGithubLogin();
  const app = Fastify();
  await app.register(githubRoutes);
  try {
    const post = await app.inject({ method: "POST", url: "/api/github/login" });
    assert.equal(post.statusCode, 200);
    assert.equal(post.json().state, "waiting");
    assert.equal(post.json().code, "1A2B-3C4D");

    const get = await app.inject({ method: "GET", url: "/api/github/login" });
    assert.equal(get.statusCode, 200);
    assert.ok(["waiting", "done"].includes(get.json().state));

    await waitFor(() => githubLoginState().state === "done");
    const done = await app.inject({ method: "GET", url: "/api/github/login" });
    assert.deepEqual(done.json(), { state: "done", login: "octo" });

    const del = await app.inject({ method: "DELETE", url: "/api/github/login" });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { state: "idle" });
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/github/login" })).json(), { state: "idle" });
  } finally {
    cancelGithubLogin();
    await app.close();
  }
});

test("the device login uses only flags gh 2.45 (Ubuntu 24.04) knows", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/github-login.ts", import.meta.url), "utf8");
  assert.ok(!source.includes('"--skip-ssh-key"'), "--skip-ssh-key is not in gh 2.45");
});

test("logins ask for the workflow scope, and a push refused for it says how to fix it", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../src/github-login.ts", "../src/cli.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(source.includes('"--scopes", "workflow"'), `${file} asks for the workflow scope`);
  }
  const { pushErrorText } = await import("../dist/runs.js");
  const refused = new Error(
    "! [remote rejected] HEAD -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/pages.yml` without `workflow` scope)",
  );
  assert.match(pushErrorText(refused, "https://github.com/o/r.git"), /gh auth refresh -h github\.com -s workflow/);
  assert.match(pushErrorText(new Error("boom"), "https://github.com/o/r.git"), /check your git credentials/);
});

test("parseScopes reads gh auth status's scope line, quoted or not, and undefined without it", () => {
  assert.deepEqual(parseScopes("  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'"), [
    "gist",
    "read:org",
    "repo",
    "workflow",
  ]);
  assert.deepEqual(parseScopes("  - Token scopes: gist, read:org, repo"), ["gist", "read:org", "repo"]);
  assert.deepEqual(parseScopes("  - Token scopes: \"repo\""), ["repo"]);
  assert.equal(parseScopes("github.com\n  ✓ Logged in to github.com account octo (keyring)"), undefined);
  assert.equal(parseScopes("You are not logged into any GitHub hosts."), undefined);
});

test("githubScopes reads both output streams and treats a non-zero gh exit as unknown", async () => {
  process.env.FAKE_GH_STATUS = "workflow";
  assert.deepEqual(await githubScopes(), ["gist", "read:org", "repo", "workflow"]);

  // No workflow scope: known scopes without it.
  process.env.FAKE_GH_STATUS = "stderr";
  assert.deepEqual(await githubScopes(), ["gist", "read:org", "repo"]);

  // A fine-grained token prints no scope line: unknown, not missing.
  process.env.FAKE_GH_STATUS = "finegrained";
  assert.equal(await githubScopes(), undefined);

  // Not logged in: gh exits non-zero.
  process.env.FAKE_GH_STATUS = "loggedout";
  assert.equal(await githubScopes(), undefined);
  delete process.env.FAKE_GH_STATUS;
});

test("a refresh runs gh auth refresh for the workflow scope, with the same code, waiting and done states", async () => {
  const log = join(root, "gh-refresh.log");
  writeFileSync(log, "");
  const saved = process.env.FAKE_GH_LOG;
  process.env.FAKE_GH_LOG = log;
  cancelGithubLogin();
  try {
    const state = await startGithubLogin({ refresh: true });
    assert.equal(state.state, "waiting");
    assert.equal(state.code, "1A2B-3C4D");
    assert.equal(state.url, "https://github.com/login/device");

    await waitFor(() => githubLoginState().state === "done");
    assert.deepEqual(githubLoginState(), { state: "done", login: "octo" });

    const calls = readFileSync(log, "utf8");
    assert.match(calls, /auth refresh --hostname github\.com --scopes workflow/);
    assert.doesNotMatch(calls, /auth login/);
  } finally {
    if (saved === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = saved;
    cancelGithubLogin();
  }
});

test("POST /api/github/login accepts { refresh: true } and still accepts no body", async () => {
  const log = join(root, "gh-refresh-route.log");
  writeFileSync(log, "");
  const saved = process.env.FAKE_GH_LOG;
  process.env.FAKE_GH_LOG = log;
  cancelGithubLogin();
  const app = Fastify();
  await app.register(githubRoutes);
  try {
    const refresh = await app.inject({
      method: "POST",
      url: "/api/github/login",
      payload: { refresh: true },
    });
    assert.equal(refresh.statusCode, 200);
    assert.equal(refresh.json().state, "waiting");
    await waitFor(() => githubLoginState().state === "done");
    assert.match(readFileSync(log, "utf8"), /auth refresh --hostname github\.com --scopes workflow/);

    cancelGithubLogin();
    const plain = await app.inject({ method: "POST", url: "/api/github/login" });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.json().state, "waiting");

    const bad = await app.inject({ method: "POST", url: "/api/github/login", payload: { refresh: "yes" } });
    assert.equal(bad.statusCode, 400);
  } finally {
    if (saved === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = saved;
    cancelGithubLogin();
    await app.close();
  }
});
