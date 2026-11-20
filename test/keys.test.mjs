// Provider keys: the private keys file, masked display, lookup precedence, the key check and the
// `hive keys` commands. HIVE_KEYS_FILE points into a temp dir before anything from dist/ is
// imported, so the real ~/.config/agent-hive/env is never touched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "hive-keys-"));
const file = join(dir, "env");
process.env.HIVE_KEYS_FILE = file;
process.env.HIVE_DOTENV_PATH = join(dir, "nonexistent.env");
for (const name of [
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODE",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEFAULT_PROVIDER",
  "DEFAULT_MODEL",
]) {
  delete process.env[name];
}

const { keySource, maskKey, readKeysFile, setKeysFileValue, testKey } = await import("../dist/keys.js");

test("setKeysFileValue sets, keeps comments and other lines, and removes one line", () => {
  writeFileSync(file, "# a comment\n");
  setKeysFileValue("A", "1");
  setKeysFileValue("B", "2");
  let text = readFileSync(file, "utf8");
  assert.match(text, /^# a comment$/m);
  assert.match(text, /^A=1$/m);
  assert.match(text, /^B=2$/m);

  setKeysFileValue("A", null);
  text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /^A=/m);
  assert.match(text, /^B=2$/m);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("setKeysFileValue refuses names and values that could inject another line", () => {
  assert.throws(() => setKeysFileValue("lowercase", "value"));
  assert.throws(() => setKeysFileValue("OK_NAME", "has space"));
  assert.throws(() => setKeysFileValue("OK_NAME", "line\nbreak"));
  assert.throws(() => setKeysFileValue("OK_NAME", 'has"quote'));
  assert.throws(() => setKeysFileValue("OK_NAME", "has#hash"));
  assert.throws(() => setKeysFileValue("OK_NAME", "back\\slash"));
  assert.throws(() => setKeysFileValue("OK_NAME", "tick`value"));
});

test("readKeysFile picks up a change made after a first read", () => {
  setKeysFileValue("D", "old");
  assert.equal(readKeysFile().D, "old");
  writeFileSync(file, "D=old\nE=newvalue\n");
  assert.equal(readKeysFile().E, "newvalue");
});

test("maskKey keeps the last 4 characters hidden in the middle", () => {
  const key = "sk-or-v1-abcdefghijklmnop1234";
  const masked = maskKey(key);
  assert.ok(masked.endsWith("1234"), `mask keeps the last 4 (got ${masked})`);
  assert.ok(!masked.includes("abcdefghij"), `mask hides the middle (got ${masked})`);
  for (const sample of ["short", "shortkey", "exactly12chr", key]) {
    assert.notEqual(maskKey(sample), sample, "no mask equals its input");
  }
});

test("keySource prefers the shell environment, then the file, then the process environment", () => {
  assert.deepEqual(keySource(["A_KEY"], { A_KEY: "shell" }, { A_KEY: "env" }, { A_KEY: "file" }), {
    value: "shell",
    source: "environment",
    name: "A_KEY",
  });
  assert.deepEqual(keySource(["A_KEY"], {}, { A_KEY: "env" }, { A_KEY: "file" }), {
    value: "file",
    source: "saved",
    name: "A_KEY",
  });
  assert.deepEqual(keySource(["A_KEY"], {}, { A_KEY: "env" }, {}), {
    value: "env",
    source: "env-file",
    name: "A_KEY",
  });
  assert.deepEqual(keySource(["B_KEY", "A_KEY"], {}, {}, { A_KEY: "file" }), {
    value: "file",
    source: "saved",
    name: "A_KEY",
  });
  assert.equal(keySource(["MISSING"], {}, {}, {}), undefined);
});

test("testKey checks the right endpoint with the right headers", async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  assert.deepEqual(await testKey("deepseek", "sk-test", fake), {
    status: "works",
    detail: "The provider accepted the key",
  });
  assert.equal(calls[0].url, "https://api.deepseek.com/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "the request has a timeout signal");
  assert.equal(calls[0].init.body, undefined, "the request has no body");
});

test("testKey reports a refused, unchecked or unreachable key", async () => {
  const refused = await testKey("openrouter", "sk-bad", async () => ({ ok: false, status: 401 }));
  assert.equal(refused.status, "refused");
  assert.match(refused.detail, /HTTP 401/);

  const anthropicCalls = [];
  await testKey("anthropic", "sk-ant", async (url, init) => {
    anthropicCalls.push({ url, init });
    return { ok: true, status: 200 };
  });
  assert.equal(anthropicCalls[0].url, "https://api.anthropic.com/v1/models");
  assert.equal(anthropicCalls[0].init.headers["x-api-key"], "sk-ant");
  assert.equal(anthropicCalls[0].init.headers["anthropic-version"], "2023-06-01");

  assert.deepEqual(await testKey("openai", "sk-x", async () => ({ ok: false, status: 500 })), {
    status: "unchecked",
    detail: "Couldn't check the key (HTTP 500)",
  });
  assert.deepEqual(
    await testKey("deepseek", "sk-x", async () => {
      throw new Error("network down");
    }),
    { status: "unchecked", detail: "Couldn't reach the provider" },
  );
  await assert.rejects(
    () => testKey("nope", "sk-x", async () => ({ ok: true, status: 200 })),
    /Unknown provider/,
  );
});

test("hive keys add --no-test saves the key and hive keys list masks it", () => {
  const added = spawnSync(process.execPath, ["dist/cli.js", "keys", "add", "zai", "--no-test"], {
    cwd: repoRoot,
    encoding: "utf8",
    input: "zk-test-1234567890\n",
    env: { ...process.env, HIVE_KEYS_FILE: file },
  });
  assert.equal(added.status, 0, added.stderr);
  assert.match(readFileSync(file, "utf8"), /^ZAI_API_KEY=zk-test-1234567890$/m);

  const listed = spawnSync(process.execPath, ["dist/cli.js", "keys", "list"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HIVE_KEYS_FILE: file },
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Z\.AI/);
  assert.match(listed.stdout, /\u2026/);
  assert.ok(!listed.stdout.includes("zk-test-1234567890"), "the list never shows the whole key");
});
