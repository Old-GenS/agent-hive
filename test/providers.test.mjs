// Provider defaults: the resolved provider/model/thinking info and what `hive doctor` prints.
// The environment is fixed before importing any dist module, because config.ts reads it at import
// time and loads .env from HIVE_DOTENV_PATH.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.HIVE_DOTENV_PATH = join(mkdtempSync(join(tmpdir(), "hive-providers-")), "nonexistent.env");
for (const name of ["DEFAULT_PROVIDER", "DEFAULT_MODEL", "DEFAULT_THINKING", "ZAI_API_KEY", "ZAI_CODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
  delete process.env[name];
}
process.env.DEEPSEEK_API_KEY = "sk-test-deepseek-secret";
process.env.OPENROUTER_API_KEY = "sk-test-openrouter-secret";

const { providerInfo } = await import("../dist/config.js");

test("providerInfo falls back to the first provider with a key", () => {
  const info = providerInfo();
  assert.deepEqual(info.default, {
    provider: "deepseek",
    providerSource: "first provider with a key",
    model: "deepseek-flash",
    modelSource: "provider default",
    thinking: "low",
  });
  const openrouter = info.providers.find((p) => p.id === "openrouter");
  assert.ok(openrouter, "openrouter is listed");
  assert.equal(openrouter.hasKey, true);
  assert.equal(openrouter.model, "xiaomi/mimo-v2.6-flash");
  const zai = info.providers.find((p) => p.id === "zai");
  assert.ok(zai, "zai is listed");
  assert.equal(zai.hasKey, false);
});

test("providerInfo honours DEFAULT_PROVIDER", () => {
  process.env.DEFAULT_PROVIDER = "openrouter";
  try {
    const info = providerInfo();
    assert.equal(info.default.provider, "openrouter");
    assert.equal(info.default.providerSource, "DEFAULT_PROVIDER");
    assert.equal(info.default.model, "xiaomi/mimo-v2.6-flash");
  } finally {
    delete process.env.DEFAULT_PROVIDER;
  }
});

test("providerInfo never includes key values", () => {
  assert.doesNotMatch(JSON.stringify(providerInfo()), /secret/);
});

test("hive doctor prints the default provider", () => {
  const result = spawnSync(process.execPath, ["dist/cli.js", "doctor"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DEFAULT_PROVIDER: "openrouter" },
  });
  assert.match(result.stdout, /^provider: openrouter \(DEFAULT_PROVIDER\)$/m);
  assert.match(result.stdout, /^model: xiaomi\/mimo-v2\.6-flash \(openrouter's default\)$/m);
  assert.match(result.stdout, /^thinking: low$/m);
});
