// Run settings (Settings › Runs): the table, this computer's limits, validation, saving to the
// keys file with mode 600, resetting, and the API routes. HIVE_KEYS_FILE points into a temp dir
// before anything from dist/ is imported, so the real ~/.config/agent-hive/env is never touched.
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "hive-settings-"));
const file = join(dir, "env");
process.env.HIVE_KEYS_FILE = file;
process.env.HIVE_DOTENV_PATH = join(dir, "nonexistent.env");
process.env.HIVE_RUNS_DIR = join(dir, "runs");
const SETTING_ENVS = [
  "HIVE_SANDBOX_CPUS",
  "HIVE_SANDBOX_MEMORY",
  "MAX_CONCURRENT_SESSIONS",
  "HIVE_SANDBOX_TIMEOUT_MIN",
  "HIVE_STALL_MIN",
  "HIVE_RUN_DISK_MAX_GB",
  "HIVE_RUN_RETENTION_DAYS",
];
for (const name of SETTING_ENVS) delete process.env[name];

const { SETTING_KEYS, applySettings, host, readSettings, resetSetting, validateSettings } = await import(
  "../dist/settings.js"
);
const { config, shellEnv } = await import("../dist/config.js");
const { capacity } = await import("../dist/web-runs.js");
const { setKeysFileValue } = await import("../dist/keys.js");
const { default: settingsRoutes } = await import("../dist/routes/settings.js");

const DEFAULTS = {
  cpus: 1,
  memoryMiB: 2048,
  maxConcurrent: 2,
  timeoutMin: 60,
  stallMin: 15,
  diskMaxGb: 20,
  retentionDays: 14,
};

function clearFile() {
  rmSync(file, { force: true });
}

/** A memory value that fits this computer's real limits (it may be small). */
function fittingMemoryMiB() {
  return Math.min(1024, host().memoryMiB - 1024);
}

test("the table has the seven settings in order", () => {
  assert.deepEqual(SETTING_KEYS, [
    "cpus",
    "memoryMiB",
    "maxConcurrent",
    "timeoutMin",
    "stallMin",
    "diskMaxGb",
    "retentionDays",
  ]);
});

test("readSettings reports defaults, this computer's limits and the env name", () => {
  clearFile();
  const h = host();
  const settings = readSettings();
  assert.deepEqual(Object.keys(settings), SETTING_KEYS);
  for (const key of SETTING_KEYS) {
    assert.equal(settings[key].source, "default", `${key} starts as a default`);
    assert.equal(settings[key].value, settings[key].default, `${key} has its default value`);
    assert.ok(settings[key].min <= settings[key].max, `${key} has sane limits`);
    assert.equal(typeof settings[key].env, "string");
  }
  assert.equal(settings.cpus.max, h.cpus);
  assert.equal(settings.memoryMiB.max, h.memoryMiB - 1024);
  assert.deepEqual(
    Object.fromEntries(SETTING_KEYS.map((key) => [key, settings[key].default])),
    DEFAULTS,
  );
});

test("validateSettings accepts values in range and returns only the patch", () => {
  const result = validateSettings(
    { cpus: 2, memoryMiB: 1024, maxConcurrent: 1, timeoutMin: 5, stallMin: 0, diskMaxGb: 0, retentionDays: 0 },
    { cpus: 8, memoryMiB: 32768 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, {
    cpus: 2,
    memoryMiB: 1024,
    maxConcurrent: 1,
    timeoutMin: 5,
    stallMin: 0,
    diskMaxGb: 0,
    retentionDays: 0,
  });
  assert.deepEqual(result.warnings, []);
});

test("validateSettings names each limit", () => {
  const h = { cpus: 8, memoryMiB: 32768 };
  const result = validateSettings(
    { cpus: 9, memoryMiB: 511, maxConcurrent: 17, timeoutMin: 1441, stallMin: 241, diskMaxGb: 1001, retentionDays: 3651 },
    h,
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.cpus, /at most 8 \(this computer's CPUs\)/);
  assert.match(result.errors.memoryMiB, /at least 512 MiB/);
  assert.match(result.errors.maxConcurrent, /at most 16/);
  assert.match(result.errors.timeoutMin, /at most 1440 minutes/);
  assert.match(result.errors.stallMin, /at most 240 minutes/);
  assert.match(result.errors.diskMaxGb, /at most 1000 GB/);
  assert.match(result.errors.retentionDays, /at most 3650 days/);

  const tooSmall = validateSettings({ cpus: 0, timeoutMin: 4, stallMin: -1, diskMaxGb: -1, retentionDays: -1 }, h);
  assert.match(tooSmall.errors.cpus, /at least 1/);
  assert.match(tooSmall.errors.timeoutMin, /at least 5 minutes/);
  assert.match(tooSmall.errors.stallMin, /at least 0 minutes/);
  assert.match(tooSmall.errors.diskMaxGb, /at least 0 GB/);
  assert.match(tooSmall.errors.retentionDays, /at least 0 days/);

  const notIntegers = validateSettings({ cpus: 1.5, timeoutMin: "60", maxConcurrent: null, retentionDays: 1.5 }, h);
  assert.match(notIntegers.errors.cpus, /whole number/);
  assert.match(notIntegers.errors.timeoutMin, /whole number/);
  assert.match(notIntegers.errors.maxConcurrent, /whole number/);
  assert.match(notIntegers.errors.retentionDays, /whole number/);

  const unknown = validateSettings({ nope: 1 }, h);
  assert.match(unknown.errors.nope, /Unknown setting/);
});

test("validateSettings rejects runs × memory that does not fit, warns when CPUs are oversubscribed", () => {
  const tooMuchMemory = validateSettings({ memoryMiB: 4096, maxConcurrent: 4 }, { cpus: 8, memoryMiB: 15872 });
  assert.equal(tooMuchMemory.ok, false);
  assert.equal(
    tooMuchMemory.errors.maxConcurrent,
    "4 runs × 4096 MiB needs 16 GiB; this computer has 15.5 GiB",
  );

  const tooManyCpus = validateSettings({ cpus: 4, maxConcurrent: 4 }, { cpus: 8, memoryMiB: 65536 });
  assert.equal(tooManyCpus.ok, true);
  assert.equal(tooManyCpus.warnings.length, 1);
  assert.match(tooManyCpus.warnings[0], /4 runs × 4 CPUs is more than this computer's 8 CPUs/);
});

test("applySettings writes the keys file (mode 600) and updates config and the queue at once", () => {
  clearFile();
  applySettings({
    cpus: 3,
    memoryMiB: 1536,
    maxConcurrent: 4,
    timeoutMin: 90,
    stallMin: 5,
    diskMaxGb: 10,
    retentionDays: 30,
  });

  const text = readFileSync(file, "utf8");
  for (const line of [
    "HIVE_SANDBOX_CPUS=3",
    "HIVE_SANDBOX_MEMORY=1536m",
    "MAX_CONCURRENT_SESSIONS=4",
    "HIVE_SANDBOX_TIMEOUT_MIN=90",
    "HIVE_STALL_MIN=5",
    "HIVE_RUN_DISK_MAX_GB=10",
    "HIVE_RUN_RETENTION_DAYS=30",
  ]) {
    assert.match(text, new RegExp(`^${line}$`, "m"), `${line} is saved`);
  }
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(config.sandbox.cpus, "3");
  assert.equal(config.sandbox.memory, "1536m");
  assert.equal(config.maxConcurrent, 4);
  assert.equal(config.sandbox.timeoutMin, 90);
  assert.equal(config.sandbox.stallMin, 5);
  assert.equal(config.sandbox.diskMaxGb, 10);
  assert.equal(config.runRetentionDays, 30);
  assert.equal(capacity().max, 4);

  const settings = readSettings();
  for (const key of SETTING_KEYS) {
    assert.equal(settings[key].source, "file", `${key} comes from the saved file`);
  }
  assert.equal(settings.cpus.value, 3);
  assert.equal(settings.memoryMiB.value, 1536);
});

test("resetSetting removes the saved value and restores the default", () => {
  resetSetting("cpus");
  assert.equal(config.sandbox.cpus, "1");
  assert.doesNotMatch(readFileSync(file, "utf8"), /^HIVE_SANDBOX_CPUS=/m);
  assert.equal(readSettings().cpus.source, "default");
  assert.equal(readSettings().cpus.value, 1);

  resetSetting("retentionDays");
  assert.equal(config.runRetentionDays, 14);
  assert.doesNotMatch(readFileSync(file, "utf8"), /^HIVE_RUN_RETENTION_DAYS=/m);
  assert.equal(readSettings().retentionDays.source, "default");
  assert.equal(readSettings().retentionDays.value, 14);

  resetSetting("maxConcurrent");
  assert.equal(config.maxConcurrent, 2);
  assert.equal(capacity().max, 2);
  assert.equal(readSettings().maxConcurrent.source, "default");
  // The other saved values are untouched.
  assert.equal(readSettings().memoryMiB.source, "file");
  assert.equal(readSettings().memoryMiB.value, 1536);
});

test("a setting set by the environment is refused when applying or resetting", () => {
  shellEnv.HIVE_SANDBOX_CPUS = "3";
  try {
    assert.equal(readSettings().cpus.source, "env");
    assert.throws(() => applySettings({ cpus: 2 }), /HIVE_SANDBOX_CPUS is set in the server's environment/);
    assert.throws(() => resetSetting("cpus"), /HIVE_SANDBOX_CPUS is set in the server's environment/);
  } finally {
    delete shellEnv.HIVE_SANDBOX_CPUS;
  }
});

test("a new process reads the saved values from the keys file at startup", () => {
  const startupFile = join(dir, "startup-env");
  setKeysFileValue("HIVE_SANDBOX_CPUS", "2", startupFile);
  setKeysFileValue("HIVE_SANDBOX_MEMORY", "1g", startupFile);
  setKeysFileValue("MAX_CONCURRENT_SESSIONS", "3", startupFile);
  setKeysFileValue("HIVE_SANDBOX_TIMEOUT_MIN", "30", startupFile);
  setKeysFileValue("HIVE_STALL_MIN", "0", startupFile);
  setKeysFileValue("HIVE_RUN_DISK_MAX_GB", "7", startupFile);
  setKeysFileValue("HIVE_RUN_RETENTION_DAYS", "21", startupFile);

  const env = { ...process.env, HIVE_KEYS_FILE: startupFile, HIVE_DOTENV_PATH: join(dir, "nonexistent.env") };
  for (const name of SETTING_ENVS) delete env[name];
  const code = `import { config } from "./dist/config.js";
    console.log(JSON.stringify({ cpus: config.sandbox.cpus, memory: config.sandbox.memory, max: config.maxConcurrent,
      timeout: config.sandbox.timeoutMin, stall: config.sandbox.stallMin, disk: config.sandbox.diskMaxGb,
      retention: config.runRetentionDays }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    cpus: "2",
    memory: "1g",
    max: 3,
    timeout: 30,
    stall: 0,
    disk: 7,
    retention: 21,
  });
});

// ── the API routes ──

const app = Fastify();
await app.register(settingsRoutes);
test.after(async () => {
  await app.close();
});

test("GET /api/settings returns the settings and this computer", async () => {
  const res = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body.settings), SETTING_KEYS);
  assert.equal(typeof body.host.cpus, "number");
  assert.equal(typeof body.host.memoryMiB, "number");
});

test("PUT /api/settings saves valid values and returns the new settings", async () => {
  clearFile();
  const h = host();
  const memoryMiB = fittingMemoryMiB();
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: { cpus: 1, memoryMiB, maxConcurrent: 1 },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.settings.cpus.value, 1);
  assert.equal(body.settings.cpus.source, "file");
  assert.equal(body.settings.memoryMiB.value, memoryMiB);
  assert.equal(body.settings.memoryMiB.source, "file");
  assert.equal(body.settings.maxConcurrent.value, 1);
  assert.deepEqual(body.host, h);
  assert.ok(Array.isArray(body.warnings));
});

test("PUT /api/settings is 400 with per-field errors", async () => {
  const h = host();
  const res = await app.inject({ method: "PUT", url: "/api/settings", payload: { cpus: h.cpus + 1 } });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.match(body.errors.cpus, /at most/);
  assert.ok(Array.isArray(body.warnings));
});

test("PUT /api/settings is 409 for a value set by the environment", async () => {
  shellEnv.HIVE_SANDBOX_CPUS = "4";
  try {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { cpus: 1, memoryMiB: fittingMemoryMiB(), maxConcurrent: 1 },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /HIVE_SANDBOX_CPUS is set in the server's environment/);
  } finally {
    delete shellEnv.HIVE_SANDBOX_CPUS;
  }
});

test("DELETE /api/settings/:key resets one setting", async () => {
  const res = await app.inject({ method: "DELETE", url: "/api/settings/cpus" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.settings.cpus.source, "default");
  assert.equal(body.settings.cpus.value, 1);
  assert.equal(config.sandbox.cpus, "1");
  assert.equal(typeof body.host.cpus, "number");
});

test("DELETE /api/settings/:key is 404 for an unknown key and 409 for an environment value", async () => {
  const missing = await app.inject({ method: "DELETE", url: "/api/settings/nope" });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().error, /Unknown setting/);

  shellEnv.HIVE_SANDBOX_TIMEOUT_MIN = "30";
  try {
    const blocked = await app.inject({ method: "DELETE", url: "/api/settings/timeoutMin" });
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().error, /HIVE_SANDBOX_TIMEOUT_MIN is set in the server's environment/);
  } finally {
    delete shellEnv.HIVE_SANDBOX_TIMEOUT_MIN;
  }
});


test("a value from the server's .env reads as dotenv, and Reset goes back to it", async () => {
  const { writeFileSync } = await import("node:fs");
  const dotenvPath = process.env.HIVE_DOTENV_PATH;
  writeFileSync(dotenvPath, "HIVE_STALL_MIN=25\n");
  try {
    clearFile();
    assert.equal(readSettings().stallMin.source, "dotenv");
    applySettings({ stallMin: 30 });
    assert.equal(readSettings().stallMin.source, "file");
    assert.equal(config.sandbox.stallMin, 30);
    resetSetting("stallMin");
    assert.equal(config.sandbox.stallMin, 25, "reset falls back to the .env value, not the default");
    assert.equal(readSettings().stallMin.source, "dotenv");
  } finally {
    rmSync(dotenvPath, { force: true });
    resetSetting("stallMin");
  }
});
