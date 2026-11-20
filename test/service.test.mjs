// `hive service`: the systemd unit and launchd plist builders, the service paths, and the CLI's
// --dry-run install. Nothing here calls systemctl, launchctl, loginctl or journalctl:
// HIVE_SERVICE_DIR and HIVE_KEYS_FILE point into temp dirs, and --dry-run runs no commands.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, "dist", "cli.js");
const { launchdPlist, servicePaths, systemdUnit } = await import("../dist/service.js");

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("systemdUnit quotes each ExecStart argument and rejects hostile ones", () => {
  const command = [process.execPath, cli, "serve", "--host", "0.0.0.0", "--port", "8080"];
  const unit = systemdUnit({ command, workdir: "/home/tester", path: "/usr/bin:/bin" });
  assert.ok(unit.includes(`ExecStart=${command.map((arg) => `"${arg}"`).join(" ")}`), unit);
  assert.match(unit, /^WorkingDirectory=\/home\/tester$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.throws(() => systemdUnit({ command: [...command, 'has"quote'], workdir: "/", path: "/bin" }));
  assert.throws(() => systemdUnit({ command: [...command, "has\\backslash"], workdir: "/", path: "/bin" }));
  assert.throws(() => systemdUnit({ command: [...command, "has\nnewline"], workdir: "/", path: "/bin" }));
});

test("launchdPlist puts each argument in its own XML-escaped <string>", () => {
  const command = ["/usr/bin/node", join(repoRoot, "a&b<c>.js"), "serve"];
  const plist = launchdPlist({
    command,
    workdir: "/home/tester",
    path: "/usr/bin:/bin",
    logFile: "/tmp/hive-service.log",
  });
  for (const arg of command) {
    const escaped = arg
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
    assert.ok(plist.includes(`<string>${escaped}</string>`), `argument ${arg} is its own <string>`);
  }
  assert.ok(!plist.includes("a&b"), "raw & is escaped");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(plist.includes("/tmp/hive-service.log"));
  assert.match(plist, /<key>Label<\/key>\s*<string>dev\.agent-hive\.server<\/string>/);
  assert.ok(plist.trimEnd().endsWith("</plist>"));
});

test("servicePaths uses HIVE_SERVICE_DIR when set", () => {
  const dir = tempDir("hive-service-paths-");
  const saved = process.env.HIVE_SERVICE_DIR;
  process.env.HIVE_SERVICE_DIR = dir;
  try {
    assert.equal(servicePaths("linux").file, join(dir, "agent-hive.service"));
    const darwin = servicePaths("darwin");
    assert.equal(darwin.file, join(dir, "dev.agent-hive.server.plist"));
    assert.equal(darwin.logFile, join(homedir(), "Library", "Logs", "agent-hive.log"));
    assert.throws(() => servicePaths("win32"), /Linux \(systemd\) and macOS \(launchd\)/);
  } finally {
    if (saved === undefined) delete process.env.HIVE_SERVICE_DIR;
    else process.env.HIVE_SERVICE_DIR = saved;
  }
});

test("hive service install --dry-run prints the unit and writes no service file", () => {
  const serviceDir = tempDir("hive-service-install-");
  const keysDir = tempDir("hive-service-keys-");
  const keys = join(keysDir, "env");
  const env = {
    ...process.env,
    HIVE_SERVICE_DIR: serviceDir,
    HIVE_KEYS_FILE: keys,
    HIVE_DOTENV_PATH: join(keysDir, "missing.env"),
  };
  delete env.API_TOKEN;
  delete env.API_TOKENS;

  const result = spawnSync(
    process.execPath,
    [cli, "service", "install", "--host", "0.0.0.0", "--port", "8080", "--dry-run"],
    { cwd: repoRoot, encoding: "utf8", env },
  );
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const expected =
    process.platform === "darwin"
      ? "<string>serve</string>"
      : `ExecStart="${process.execPath}" "${cli}" "serve" "--host" "0.0.0.0" "--port" "8080"`;
  assert.ok(result.stdout.includes(expected), result.stdout);

  // --dry-run runs nothing and writes nothing into the service folder.
  assert.deepEqual(readdirSync(serviceDir), []);

  // It does create the login token, exactly like `hive serve`, but never prints it.
  const text = readFileSync(keys, "utf8");
  const token = /^API_TOKEN=([0-9a-f]{48})$/m.exec(text)?.[1];
  assert.ok(token, `keys file has a 48-hex-character API_TOKEN:\n${text}`);
  assert.ok(!result.stdout.includes(token), "stdout does not contain the token");
  assert.ok(!result.stderr.includes(token), "stderr does not contain the token");
});
