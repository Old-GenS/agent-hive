// The server's GitHub device login: parsing gh's code, the states of a login around a fake `gh`,
// and the three routes. No real gh and no network: GH_BIN points at a shell script.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const root = mkdtempSync(join(tmpdir(), "hive-github-login-"));
const fakeGh = join(root, "gh");
writeFileSync(
  fakeGh,
  `#!/bin/sh
# A fake gh for test/github-login.test.mjs. FAKE_GH_MODE picks the auth-login behaviour.
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

const { parseDeviceCode, startGithubLogin, githubLoginState, cancelGithubLogin, setGithubLoginTimeouts } =
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
