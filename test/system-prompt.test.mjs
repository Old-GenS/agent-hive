// The agent instructions: the editable default (env > file > built-in), atomic saving with mode
// 600, composing per-run instructions, and the Settings › Runs routes. XDG_CONFIG_HOME points at
// a temp dir before any dist/ import, so the real ~/.config/agent-hive/system-prompt.md is never
// touched.
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hive-system-prompt-"));
const configHome = join(root, "config");
process.env.XDG_CONFIG_HOME = configHome;
process.env.HIVE_KEYS_FILE = join(root, "missing-keys");
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
process.env.HIVE_RUNS_DIR = join(root, "runs");
delete process.env.HIVE_SYSTEM_PROMPT;

const {
  BUILTIN_SYSTEM_PROMPT,
  MAX_SYSTEM_PROMPT,
  composeSystemPrompt,
  defaultSystemPrompt,
  resetSystemPrompt,
  saveSystemPrompt,
  systemPromptPath,
} = await import("../dist/system-prompt.js");
const { default: settingsRoutes } = await import("../dist/routes/settings.js");

const promptPath = join(configHome, "agent-hive", "system-prompt.md");

function clearPrompt() {
  rmSync(promptPath, { force: true });
}

test("the prompt path follows XDG_CONFIG_HOME", () => {
  assert.equal(systemPromptPath(), promptPath);
});

test("defaultSystemPrompt prefers HIVE_SYSTEM_PROMPT, then a non-empty file, then the built-in", () => {
  clearPrompt();
  assert.deepEqual(defaultSystemPrompt(), { text: BUILTIN_SYSTEM_PROMPT, source: "builtin" });

  const saved = saveSystemPrompt("  My default instructions.  ");
  assert.equal(saved, undefined);
  assert.deepEqual(defaultSystemPrompt(), { text: "My default instructions.", source: "file" });

  process.env.HIVE_SYSTEM_PROMPT = "  From the environment.  ";
  try {
    // The env value keeps its own whitespace, exactly as the old config.systemPrompt did.
    assert.deepEqual(defaultSystemPrompt(), { text: "  From the environment.  ", source: "env" });
  } finally {
    delete process.env.HIVE_SYSTEM_PROMPT;
  }
  assert.deepEqual(defaultSystemPrompt(), { text: "My default instructions.", source: "file" });
});

test("a whitespace-only file counts as absent", () => {
  saveSystemPrompt("temp");
  writeFileSync(promptPath, " \n\t\n");
  assert.deepEqual(defaultSystemPrompt(), { text: BUILTIN_SYSTEM_PROMPT, source: "builtin" });
  clearPrompt();
});

test("saveSystemPrompt trims, writes atomically with mode 600, and rejects empty or too long text", () => {
  clearPrompt();
  saveSystemPrompt("\n  Only this text.  \n");
  assert.equal(readFileSync(promptPath, "utf8"), "Only this text.");
  assert.equal(statSync(promptPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(configHome, "agent-hive")), ["system-prompt.md"], "no temp file is left behind");

  for (const bad of ["", "   \n\t ", "x".repeat(MAX_SYSTEM_PROMPT + 1)]) {
    assert.throws(() => saveSystemPrompt(bad), /empty|too long/);
  }
  assert.equal(readFileSync(promptPath, "utf8"), "Only this text.", "a rejected save leaves the old text");
});

test("resetSystemPrompt deletes the file and is fine when there is none", () => {
  saveSystemPrompt("remove me");
  resetSystemPrompt();
  assert.deepEqual(defaultSystemPrompt(), { text: BUILTIN_SYSTEM_PROMPT, source: "builtin" });
  assert.doesNotThrow(() => resetSystemPrompt());
});

test("composeSystemPrompt adds, replaces, and ignores empty instructions", () => {
  const base = "base instructions";
  for (const extra of [undefined, "", "  \n\t "]) {
    assert.equal(composeSystemPrompt(base, extra), base);
    assert.equal(composeSystemPrompt(base, extra, "replace"), base);
  }

  assert.equal(
    composeSystemPrompt(base, "  Prefer small commits.  "),
    "base instructions\n\nInstructions for this run:\nPrefer small commits.",
  );
  assert.equal(composeSystemPrompt(base, "  Only this.  ", "replace"), "Only this.");
  assert.equal(composeSystemPrompt(base, "Only this.", "add"), "base instructions\n\nInstructions for this run:\nOnly this.");
  assert.throws(() => composeSystemPrompt(base, "x".repeat(MAX_SYSTEM_PROMPT + 1)), /too long/);
});

// ── Settings › Runs: the agent-instructions routes ──

const app = Fastify();
await app.register(settingsRoutes);
test.after(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /api/settings/system-prompt describes the current default", async () => {
  clearPrompt();
  const res = await app.inject({ method: "GET", url: "/api/settings/system-prompt" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    text: BUILTIN_SYSTEM_PROMPT,
    source: "builtin",
    builtin: BUILTIN_SYSTEM_PROMPT,
    max: MAX_SYSTEM_PROMPT,
  });
});

test("PUT /api/settings/system-prompt saves, and 400s on empty or too long text", async () => {
  clearPrompt();
  const saved = await app.inject({
    method: "PUT",
    url: "/api/settings/system-prompt",
    payload: { text: "  Saved from the API.  " },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().text, "Saved from the API.");
  assert.equal(saved.json().source, "file");
  assert.equal(readFileSync(promptPath, "utf8"), "Saved from the API.");

  for (const text of ["", " \n ", "x".repeat(MAX_SYSTEM_PROMPT + 1)]) {
    const res = await app.inject({ method: "PUT", url: "/api/settings/system-prompt", payload: { text } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /empty|too long/);
  }
});

test("DELETE /api/settings/system-prompt resets to the built-in default", async () => {
  saveSystemPrompt("delete me");
  const res = await app.inject({ method: "DELETE", url: "/api/settings/system-prompt" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().source, "builtin");
  assert.equal(res.json().text, BUILTIN_SYSTEM_PROMPT);

  const again = await app.inject({ method: "DELETE", url: "/api/settings/system-prompt" });
  assert.equal(again.statusCode, 200, "resetting when there is no file is fine");
});

test("the routes are 409 while HIVE_SYSTEM_PROMPT sets the default", async () => {
  process.env.HIVE_SYSTEM_PROMPT = "from the environment";
  try {
    const get = await app.inject({ method: "GET", url: "/api/settings/system-prompt" });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().source, "env");

    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/system-prompt",
      payload: { text: "cannot save this" },
    });
    assert.equal(put.statusCode, 409);
    assert.match(put.json().error, /HIVE_SYSTEM_PROMPT/);

    const del = await app.inject({ method: "DELETE", url: "/api/settings/system-prompt" });
    assert.equal(del.statusCode, 409);
    assert.match(del.json().error, /HIVE_SYSTEM_PROMPT/);
  } finally {
    delete process.env.HIVE_SYSTEM_PROMPT;
  }
});
