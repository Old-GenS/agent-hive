// Live usage for Settings > This computer, against fake /proc and /sys trees. The env points at
// temp paths before anything from dist/ is imported, so no real keys file or workspace is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "hive-usage-"));
process.env.HIVE_DOTENV_PATH = join(scratch, "missing.env");
process.env.HIVE_KEYS_FILE = join(scratch, "missing-keys");
process.env.WORKSPACE = join(scratch, "workspace");

const { usageNow } = await import("../dist/usage.js");

function tree(files) {
  const root = mkdtempSync(join(scratch, "tree-"));
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

test("usageNow reads memory, disk, cores and an hwmon CPU sensor", async () => {
  const sysRoot = tree({
    "proc/meminfo": "MemTotal: 8388608 kB\nMemAvailable: 2097152 kB\n",
    "sys/class/hwmon/hwmon3/name": "coretemp\n",
    "sys/class/hwmon/hwmon3/temp1_input": "58000\n",
  });
  const diskPath = mkdtempSync(join(scratch, "disk-"));
  const usage = await usageNow({ sysRoot, diskPath });

  assert.deepEqual(usage.temperature, { celsius: 58, sensor: "coretemp" });
  assert.equal(usage.memory.usedBytes, totalmem() - 2097152 * 1024);
  assert.equal(usage.memory.totalBytes, totalmem());
  assert.equal(usage.cpu.cores, cpus().length);
  assert.ok(usage.cpu.percent >= 0 && usage.cpu.percent <= 100, `cpu.percent is 0-100 (got ${usage.cpu.percent})`);
  assert.ok(usage.disk.totalBytes > 0, "disk.totalBytes is measured");
  assert.equal(usage.disk.path, diskPath);
});

test("usageNow falls back to a thermal zone named x86_pkg_temp", async () => {
  const sysRoot = tree({
    "sys/class/thermal/thermal_zone0/type": "x86_pkg_temp\n",
    "sys/class/thermal/thermal_zone0/temp": "61000\n",
  });
  const usage = await usageNow({ sysRoot, diskPath: mkdtempSync(join(scratch, "disk-")) });
  assert.deepEqual(usage.temperature, { celsius: 61, sensor: "x86_pkg_temp" });
});

test("usageNow reports no temperature when the machine has none", async () => {
  const sysRoot = tree({});
  const usage = await usageNow({ sysRoot, diskPath: mkdtempSync(join(scratch, "disk-")) });
  assert.equal(usage.temperature, null);
});
