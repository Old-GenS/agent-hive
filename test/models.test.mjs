// Model lists per provider. The environment is fixed before importing any dist module, because
// config.ts reads it at import time and loads .env from HIVE_DOTENV_PATH.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.HIVE_DOTENV_PATH = join(mkdtempSync(join(tmpdir(), "hive-models-")), "nonexistent.env");
delete process.env.DEFAULT_MODEL;

const { clearModelCache, listModels } = await import("../dist/models.js");

test("deepseek returns its fixed model list", async () => {
  assert.deepEqual(await listModels("deepseek"), ["deepseek-v4-pro", "deepseek-flash"]);
});

test("openrouter returns the live list sorted, de-duplicated, with the default first", async () => {
  clearModelCache();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "b/x" }, { id: "a/y" }, { id: "b/x" }] }),
  });
  assert.deepEqual(await listModels("openrouter", fetchImpl), ["xiaomi/mimo-v2.6-flash", "a/y", "b/x"]);
});

test("openrouter falls back when the live list can't be fetched", async () => {
  clearModelCache();
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await listModels("openrouter", fetchImpl), ["xiaomi/mimo-v2.6-flash"]);
});

test("an unknown provider is rejected", async () => {
  await assert.rejects(() => listModels("nope"), /Unknown provider/);
});
