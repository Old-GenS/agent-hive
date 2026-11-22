// The first-run onboarding API: one GET that says whether setup is needed (checks with fixes,
// key and GitHub state, rootfs download state) and the POST that starts a rootfs download.
// A bare Fastify app: no auth hook, no server process, no VM.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

// Fixed before any dist/ import: config.ts captures the starting environment at import time.
// No provider key exists in it, so "hasKey: false" is about an empty machine.
const root = mkdtempSync(join(tmpdir(), "hive-onboarding-"));
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
process.env.HIVE_KEYS_FILE = join(root, "missing-keys");
delete process.env.HIVE_BUNDLE_ROOT;
const PROVIDER_ENV = [
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODE",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEFAULT_PROVIDER",
];
for (const name of PROVIDER_ENV) delete process.env[name];

const { default: onboardingRoutes } = await import("../dist/routes/onboarding.js");

const app = Fastify();
await app.register(onboardingRoutes);
test.after(async () => {
  await app.close();
});

test("GET /api/onboarding: a bare machine needs setup and has no key", async () => {
  const res = await app.inject({ method: "GET", url: "/api/onboarding" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.hasKey, false);
  assert.equal(body.needed, true);
  assert.equal(body.defaultProvider, null);
  assert.equal(typeof body.github, "object");
  assert.equal(body.host.bundle, false);
  assert.equal(typeof body.host.distro, "string");
  assert.equal(typeof body.host.wsl, "boolean");
  // The five checks, each with an id; a failing one carries its distro-aware fix. The network
  // check is pasta on Linux and one vsock port on macOS.
  assert.deepEqual(
    body.checks.map((check) => check.id),
    ["kvm", "libkrun", process.platform === "darwin" ? "network" : "pasta", "launcher", "rootfs"],
  );
  for (const check of body.checks) {
    assert.equal(typeof check.name, "string");
    assert.equal(typeof check.ok, "boolean");
    assert.equal(typeof check.detail, "string");
    if (check.ok) assert.equal(check.fix, undefined);
    else {
      assert.equal(typeof check.fix.text, "string");
      assert.ok(check.fix.command === undefined || typeof check.fix.command === "string");
    }
  }
  // From a source checkout the VM filesystem cannot be downloaded.
  assert.equal(body.rootfs.canDownload, false);
  assert.equal(body.rootfs.download.state, "idle");
  assert.equal(typeof body.rootfs.download.received, "number");
});

test("GET /api/onboarding: a provider key in the environment means hasKey", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-onboarding-secret";
  try {
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.hasKey, true);
    assert.equal(body.defaultProvider, "deepseek");
    assert.doesNotMatch(JSON.stringify(body), /onboarding-secret/);
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("POST /api/setup/rootfs fails from a source checkout", async () => {
  const res = await app.inject({ method: "POST", url: "/api/setup/rootfs" });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(typeof body.error, "string");
  // macOS has no image to build yet, so its message names the missing arm64 image instead.
  assert.match(body.error, process.platform === "darwin" ? /arm64 VM image/ : /source|installed release/);
});
