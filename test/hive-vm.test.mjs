// CLI tests for the libkrun launcher: parsing, validation and the --dry-run JSON contract.
// They never boot a VM; --dry-run stops before libkrun is loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(repoRoot, "vm", "hive-vm");

const base = mkdtempSync(join(tmpdir(), "hive-vm-test-"));
const dirA = join(base, "a");
const dirB = join(base, "b");
const dirC = join(base, "c");
for (const dir of [dirA, dirB, dirC]) mkdirSync(dir);

// --dry-run exits before libkrun is loaded, so this only needs a built binary.
function dryRun(args, env = {}) {
  assert.ok(existsSync(bin), `vm/hive-vm is missing; build it with: bash vm/build.sh`);
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.error, undefined);
  return result;
}

function dryRunJson(args, env = {}) {
  const result = dryRun(args, env);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("dry run reports the full configuration as JSON and never leaks env values", () => {
  const result = dryRun(
    [
      "--dry-run",
      "--rootfs", dirA,
      "--cpus", "2",
      "--memory", "2048",
      "--share", `${dirB}:/work`,
      "--share", `${dirC}:/session:ro`,
      "--env", "SECRET_KEY",
      "--setenv", "FOO=bar",
      "--dns", "169.254.1.53",
      "--workdir", "/work",
      "--", "hive-agent", "--model", "x",
    ],
    { SECRET_KEY: "sk-test-123" },
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.cpus, 2);
  assert.equal(out.memory, 2048);
  assert.deepEqual(out.shares[0], { tag: "hive0", host: realpathSync(dirB), guest: "/work", ro: false });
  assert.equal(out.shares[1].ro, true);
  assert.deepEqual(out.env, ["SECRET_KEY", "FOO"]);
  assert.equal(out.exec, "/usr/local/bin/hive-vm-init");
  assert.deepEqual(out.argv, ["hive-agent", "--model", "x"]);
  assert.ok(!result.stdout.includes("sk-test-123"), "dry run must not print env values");
});

test("--env of an unset variable is omitted", () => {
  const env = { ...process.env };
  delete env.UNSET_VAR_XYZ;
  const out = dryRunJson(
    ["--dry-run", "--rootfs", dirA, "--env", "UNSET_VAR_XYZ", "--", "true"],
    env,
  );
  assert.ok(!out.env.includes("UNSET_VAR_XYZ"));
});

test("exit 2 on invalid arguments", () => {
  const cases = [
    ["--dry-run", "--rootfs", "relative/dir", "--", "true"],
    ["--dry-run", "--", "true"],
    ["--dry-run", "--rootfs", dirA, "--share", `${join(dirA, "missing")}:/work`, "--", "true"],
    ["--dry-run", "--rootfs", dirA, "--share", `${dirB}:/a/../b`, "--", "true"],
    ["--dry-run", "--rootfs", dirA, "--share", `${dirB}:relative`, "--", "true"],
    ["--dry-run", "--rootfs", dirA, "--memory", "64", "--", "true"],
    ["--dry-run", "--rootfs", dirA, "--cpus", "0", "--", "true"],
    ["--dry-run", "--rootfs", dirA, "--"],
    ["--dry-run", "--rootfs", dirA, "--setenv", "1BAD=x", "--", "true"],
  ];
  for (const args of cases) {
    const result = dryRun(args);
    assert.equal(result.status, 2, `expected exit 2 for ${JSON.stringify(args)}; stderr: ${result.stderr}`);
    assert.ok(result.stderr.startsWith("hive-vm: "), `stderr should start with the program name: ${result.stderr}`);
  }
});

test("--watch-pid and --timeout appear in the dry-run JSON as numbers", () => {
  const out = dryRunJson(["--dry-run", "--rootfs", dirA, "--watch-pid", "1234", "--timeout", "60", "--", "true"]);
  assert.equal(out.watch_pid, 1234);
  assert.equal(out.timeout, 60);
});

test("--watch-pid and --timeout are null in the dry-run JSON when absent", () => {
  const out = dryRunJson(["--dry-run", "--rootfs", dirA, "--", "true"]);
  assert.equal(out.watch_pid, null);
  assert.equal(out.timeout, null);
});

test("exit 2 on invalid --watch-pid and --timeout values", () => {
  const cases = [
    ["--dry-run", "--rootfs", dirA, "--watch-pid", "0", "--", "true"],
    ["--dry-run", "--rootfs", dirA, "--watch-pid", "abc", "--", "true"],
    ["--dry-run", "--rootfs", dirA, "--timeout", "0", "--", "true"],
  ];
  for (const args of cases) {
    const result = dryRun(args);
    assert.equal(result.status, 2, `expected exit 2 for ${JSON.stringify(args)}; stderr: ${result.stderr}`);
    assert.ok(result.stderr.startsWith("hive-vm: "), `stderr should start with the program name: ${result.stderr}`);
  }
});

test("dns is null when --dns is absent", () => {
  const out = dryRunJson(["--dry-run", "--rootfs", dirA, "--", "true"]);
  assert.equal(out.dns, null);
});

test("--stderr-file is reported in the dry-run JSON", () => {
  const out = dryRunJson(["--dry-run", "--rootfs", dirA, "--stderr-file", "/tmp/x.log", "--", "true"]);
  assert.equal(out.stderr_file, "/tmp/x.log");
});

test("stderr_file is null in the dry-run JSON when --stderr-file is absent", () => {
  const out = dryRunJson(["--dry-run", "--rootfs", dirA, "--", "true"]);
  assert.equal(out.stderr_file, null);
});

test("--stderr-file must be an absolute path", () => {
  const result = dryRun(["--dry-run", "--rootfs", dirA, "--stderr-file", "x.log", "--", "true"]);
  assert.equal(result.status, 2, `stderr: ${result.stderr}`);
  assert.ok(result.stderr.startsWith("hive-vm: "), `stderr should start with the program name: ${result.stderr}`);
});
