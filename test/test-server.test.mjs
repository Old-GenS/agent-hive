// scripts/test-server.sh: install/uninstall/update/status against a fake systemctl and a stub
// try-test-build.sh. Nothing here touches the real systemd: SYSTEMCTL points at a script that logs
// its arguments, and HIVE_TEST_SERVER_UNIT_DIR at a temporary directory.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const realScript = join(repoRoot, "scripts", "test-server.sh");
const root = mkdtempSync(join(tmpdir(), "hive-test-server-"));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// A stub try-test-build.sh: `--list` prints STUB_LIST (or fails when it is empty); a tag succeeds.
const TRY_STUB = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--list" ]; then
  if [ -z "\${STUB_LIST:-}" ]; then
    echo "stub: could not reach GitHub" >&2
    exit 1
  fi
  printf '%s\\n' "\${STUB_LIST}"
  exit 0
fi
if [ "\${1:-}" = "--clean" ]; then
  exit 0
fi
printf 'ran %s\\n' "$*"
`;

// A fake systemctl: log the call, answer is-active, never touch anything real.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${SYSTEMCTL_LOG:?}"
if [ "\${1:-}" = "--user" ] && [ "\${2:-}" = "is-active" ]; then
  echo "\${SYSTEMCTL_STATE:-inactive}"
  exit "\${SYSTEMCTL_STATE_EXIT:-3}"
fi
exit 0
`;

function sandbox(name) {
  const dir = join(root, name);
  const scripts = join(dir, "scripts");
  mkdirSync(scripts, { recursive: true });
  const unitDir = join(dir, "units");
  mkdirSync(unitDir, { recursive: true });
  const systemctl = join(dir, "systemctl");
  writeFileSync(systemctl, SYSTEMCTL_STUB, { mode: 0o755 });
  const log = join(dir, "systemctl.log");
  writeFileSync(log, "");
  copyFileSync(realScript, join(scripts, "test-server.sh"));
  writeFileSync(join(scripts, "try-test-build.sh"), TRY_STUB, { mode: 0o755 });
  return {
    dir,
    script: join(scripts, "test-server.sh"),
    units: unitDir,
    systemctl,
    log,
    serveHome: join(dir, "serve"),
    cache: join(dir, "test-builds"),
  };
}

function run(box, args, extra = {}) {
  const result = spawnSync("bash", [box.script, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: box.dir,
      HIVE_TEST_SERVER_UNIT_DIR: box.units,
      HIVE_TEST_SERVE_HOME: box.serveHome,
      SYSTEMCTL: box.systemctl,
      SYSTEMCTL_LOG: box.log,
      ...extra,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A staging home whose current build is written, with the runs folder the update check reads. */
function seedHome(box, current, runs = {}) {
  mkdirSync(box.serveHome, { recursive: true });
  writeFileSync(join(box.serveHome, "current"), `${current}\n`);
  for (const [name, meta] of Object.entries(runs)) {
    const dir = join(box.serveHome, "cache", "agent-hive", "runs", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  }
}

function systemctlLog(box) {
  return readFileSync(box.log, "utf8");
}

test("test-server.sh install writes the service and its update timer", () => {
  const box = sandbox("install");
  const result = run(box, ["install", "--port", "9999", "--host", "0.0.0.0"]);
  assert.equal(result.status, 0, result.stderr);

  const service = readFileSync(join(box.units, "agent-hive-test.service"), "utf8");
  assert.match(service, /ExecStart=.*--serve --port 9999 --host 0\.0\.0\.0/);
  assert.match(service, /Description=.*http:\/\/0\.0\.0\.0:9999\/ui\//);
  assert.match(service, /Environment=PATH=/);
  assert.match(service, /Restart=on-failure/);
  assert.match(service, /RestartSec=30/);
  assert.match(service, /WantedBy=default\.target/);

  const update = readFileSync(join(box.units, "agent-hive-test-update.service"), "utf8");
  assert.match(update, /Type=oneshot/);
  assert.match(update, /ExecStart=.*test-server\.sh update/);

  const timer = readFileSync(join(box.units, "agent-hive-test-update.timer"), "utf8");
  assert.match(timer, /OnBootSec=5min/);
  assert.match(timer, /OnUnitActiveSec=15min/);
  assert.match(timer, /WantedBy=timers\.target/);

  const log = systemctlLog(box);
  assert.match(log, /--user daemon-reload/);
  assert.match(log, /--user enable --now agent-hive-test\.service/);
  assert.match(log, /--user enable --now agent-hive-test-update\.timer/);

  assert.match(result.stdout, /http:\/\/0\.0\.0\.0:9999\/ui\//);
});

test("test-server.sh install --no-auto-update writes no timer", () => {
  const box = sandbox("install-no-update");
  const result = run(box, ["install", "--no-auto-update"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(box.units, "agent-hive-test.service")));
  assert.ok(!existsSync(join(box.units, "agent-hive-test-update.service")));
  assert.ok(!existsSync(join(box.units, "agent-hive-test-update.timer")));
  assert.ok(!systemctlLog(box).includes("agent-hive-test-update.timer"));
});

test("test-server.sh update does nothing when the newest build is current", () => {
  const box = sandbox("update-current");
  seedHome(box, "test-7-1.2.7");
  const result = run(box, ["update"], { STUB_LIST: "test-7-1.2.7  2026-01-01T00:00:00Z" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up to date: test-7-1\.2\.7/);
  assert.ok(!systemctlLog(box).includes("restart"));
});

test("test-server.sh update waits while a run is active", () => {
  const box = sandbox("update-active-run");
  seedHome(box, "test-7-1.2.7", { x: { status: "running" } });
  const result = run(box, ["update"], { STUB_LIST: "test-8-1.2.8  2026-01-02T00:00:00Z" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /a run is active on staging; not switching to test-8-1\.2\.8 yet/);
  assert.ok(!systemctlLog(box).includes("restart"));
});

test("test-server.sh update switches when the runs are finished", () => {
  const box = sandbox("update-finished-runs");
  seedHome(box, "test-7-1.2.7", { x: { status: "idle" } });
  const result = run(box, ["update"], { STUB_LIST: "test-8-1.2.8  2026-01-02T00:00:00Z" });
  assert.equal(result.status, 0, result.stderr);
  const log = systemctlLog(box);
  assert.match(log, /--user restart agent-hive-test\.service/);
  assert.match(result.stdout, /switched staging to test-8-1\.2\.8/);
});

test("test-server.sh update stays put when the build list fails", () => {
  const box = sandbox("update-list-fails");
  seedHome(box, "test-7-1.2.7");
  const result = run(box, ["update"], { STUB_LIST: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /could not list test builds; staying on test-7-1\.2\.7/);
  assert.ok(!systemctlLog(box).includes("restart"));
});

test("test-server.sh uninstall removes the unit files", () => {
  const box = sandbox("uninstall");
  assert.equal(run(box, ["install"]).status, 0);
  const result = run(box, ["uninstall"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(join(box.units, "agent-hive-test.service")));
  assert.ok(!existsSync(join(box.units, "agent-hive-test-update.service")));
  assert.ok(!existsSync(join(box.units, "agent-hive-test-update.timer")));
  const log = systemctlLog(box);
  assert.match(log, /--user disable --now agent-hive-test\.service/);
  assert.match(log, /--user disable --now agent-hive-test-update\.timer/);
  assert.match(result.stdout, /--clean/);
});

test("test-server.sh status reports the service and the build", () => {
  const box = sandbox("status");
  seedHome(box, "test-7-1.2.7");
  assert.equal(run(box, ["install", "--port", "9998"]).status, 0);
  const result = run(box, ["status"], { SYSTEMCTL_STATE: "active", SYSTEMCTL_STATE_EXIT: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /active/);
  assert.match(result.stdout, /test-7-1\.2\.7/);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:9998\/ui\//);
  assert.match(result.stdout, /API_TOKEN/);
});

test("test-server.sh --help prints the usage", () => {
  const box = sandbox("help");
  const result = run(box, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: test-server\.sh install/);
});

test("test-server.sh parses with bash -n", () => {
  const result = spawnSync("bash", ["-n", realScript], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
