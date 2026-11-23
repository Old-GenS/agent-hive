#!/usr/bin/env node
/**
 * macOS microVM network-isolation smoke test. Run it on an Apple silicon Mac with Hypervisor
 * framework and a built arm64 rootfs image:
 *
 *   HIVE_LIBKRUN=.scratch/prefix/lib/libkrun.1.19.8.dylib \
 *   HIVE_ROOTFS=/tmp/hive-arm64/rootfs.img \
 *   node scripts/macos-smoke.mjs
 *
 * It boots a real VM through runSandbox() (the product path: egress proxy -> vsock bridge ->
 * hive-vm --vsock -> hive-vm-init -> hive-netd) and checks that the guest has no IP network, that
 * only the proxy works, and that the proxy refuses the host's LAN and the cloud metadata address.
 * This is the macOS counterpart of scripts/vm-smoke.mjs; GitHub's macOS runners cannot nest HVF,
 * so it is run by hand on real hardware (docs/MACOS.md).
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const image = process.env.HIVE_ROOTFS;

function fail(message) {
  process.stderr.write(`macos-smoke: ${message}\n`);
  process.exit(2);
}

if (process.platform !== "darwin") fail("this test only runs on macOS");
if (process.arch !== "arm64") fail("this test only runs on Apple silicon");
if (!existsSync(join(repoRoot, "dist", "sandbox.js"))) fail("build first: npm run build");
if (!image) fail("set HIVE_ROOTFS to an arm64 raw ext4 image (build/rootfs-image or ~/.local/share/agent-hive/rootfs/current.img)");
if (!existsSync(image) || !statSync(image).isFile()) fail(`HIVE_ROOTFS is not a file: ${image}`);
if (!existsSync(process.env.HIVE_VM_BIN || join(repoRoot, "vm", "hive-vm"))) fail("build the launcher first: npm run build:vm");

let hv = "0";
try {
  hv = execFileSync("sysctl", ["-n", "kern.hv_support"], { encoding: "utf8" }).trim();
} catch {
  // Treated as unavailable below.
}
if (hv !== "1") fail("Hypervisor.framework is not available (kern.hv_support is not 1)");

/** A private IPv4 address of this Mac, so the guest has a real LAN destination to try to reach. */
function privateIPv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (/^10\./.test(entry.address)) return entry.address;
      if (/^192\.168\./.test(entry.address)) return entry.address;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) return entry.address;
    }
  }
  return undefined;
}

function lanServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hive-lan\n");
    });
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve(server));
  });
}

// One JSON line per check, written by the guest script.
const CHECKS = [
  "no-ip-network",
  "tsi-off",
  "proxy-https",
  "proxy-http",
  "lan-refused",
  "metadata-refused",
  "direct-lan-refused",
  "direct-public-refused",
  "dns-refused",
  "ping-refused",
];

const GUEST_SCRIPT = `
emit() {
  printf '{"name":"%s","ok":%s,"detail":"%s"}\\n' "$1" "$2" "$3"
}

ifaces=""
for d in /sys/class/net/*; do
  n=$(basename "$d")
  [ "$n" = lo ] || [ "$n" = dummy0 ] || ifaces="$ifaces $n"
done
if [ -z "$ifaces" ]; then
  emit no-ip-network true "lo and a down dummy0 only"
else
  emit no-ip-network false "unexpected interface(s):$ifaces"
fi

if grep -q tsi_hijack /proc/cmdline 2>/dev/null; then
  emit tsi-off false "tsi_hijack is on the kernel command line"
else
  emit tsi-off true "no tsi_hijack"
fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -x http://127.0.0.1:3128 https://example.com 2>/dev/null || true)
if [ "$code" = "200" ]; then emit proxy-https true "$code"; else emit proxy-https false "status $code"; fi
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -x http://127.0.0.1:3128 http://example.com/ 2>/dev/null || true)
if [ "$code" = "200" ]; then emit proxy-http true "$code"; else emit proxy-http false "status $code"; fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -x http://127.0.0.1:3128 "http://$LAN_IP:$LAN_PORT/" 2>/dev/null || true)
if [ "$code" = "403" ]; then emit lan-refused true "$code"; else emit lan-refused false "status $code"; fi
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -x http://127.0.0.1:3128 http://169.254.169.254/ 2>/dev/null || true)
if [ "$code" = "403" ]; then emit metadata-refused true "$code"; else emit metadata-refused false "status $code"; fi

if curl -sS --noproxy '*' --max-time 5 "http://$LAN_IP:$LAN_PORT/" >/dev/null 2>&1; then
  emit direct-lan-refused false "the guest reached the host LAN directly"
else
  emit direct-lan-refused true "refused"
fi
if curl -sS --noproxy '*' --max-time 5 http://1.1.1.1/ >/dev/null 2>&1; then
  emit direct-public-refused false "the guest reached a public IP directly"
else
  emit direct-public-refused true "refused"
fi
if getent hosts example.com >/dev/null 2>&1; then
  emit dns-refused false "the guest resolved a name itself"
else
  emit dns-refused true "no resolver"
fi
if ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; then
  emit ping-refused false "ping reached a public IP"
else
  emit ping-refused true "no route"
fi
`;

async function main() {
  if (process.exitCode !== undefined) return;
  const lanIp = privateIPv4();
  if (lanIp === undefined) throw new Error("no private IPv4 address on this Mac; connect to a LAN or Wi-Fi network");
  process.stderr.write(`macos-smoke: LAN ${lanIp}, image ${image}\n`);
  const server = await lanServer();
  const lanPort = server.address().port;
  const work = mkdtempSync(join(tmpdir(), "hive-macos-smoke-"));
  const ioDir = join(work, "io");
  const workDir = join(work, "work");
  mkdirSync(ioDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const events = new Map();
  const { runSandbox } = await import("../dist/sandbox.js");
  let handle;
  try {
    process.stderr.write("macos-smoke: booting the VM\n");
    handle = await runSandbox({
      name: "macos-smoke",
      mounts: [{ host: workDir, container: "/work" }],
      env: { LAN_IP: lanIp, LAN_PORT: String(lanPort) },
      command: ["bash", "-c", GUEST_SCRIPT],
      ioDir,
      onEvent: (event) => {
        if (event && typeof event.name === "string") events.set(event.name, event);
      },
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 120 * 1000));
    const result = await Promise.race([handle.done, timeout]);
    if (result === "timeout") {
      await handle.stop();
      throw new Error("the VM did not finish within 2 minutes");
    }
    if (result.code !== 0 || result.timedOut) {
      const detail = result.stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
      throw new Error(`the VM exited ${result.code}${result.timedOut ? " (timed out)" : ""}: ${detail}`);
    }
  } catch (err) {
    if (handle) await handle.stop();
    // Show whatever the guest managed to write before giving up.
    for (const name of CHECKS) {
      const event = events.get(name);
      if (event !== undefined) process.stdout.write(`${event.ok === true ? "ok" : "FAIL"} ${name}\n`);
    }
    throw err;
  } finally {
    if (handle) await handle.stop();
    server.close();
    rmSync(work, { recursive: true, force: true });
  }

  let failed = 0;
  for (const name of CHECKS) {
    const event = events.get(name);
    if (event === undefined) {
      process.stdout.write(`FAIL ${name}: no result from the VM\n`);
      failed++;
    } else if (event.ok === true) {
      process.stdout.write(`ok ${name}\n`);
    } else {
      process.stdout.write(`FAIL ${name}: ${event.detail ?? "no detail"}\n`);
      failed++;
    }
  }
  if (failed > 0) {
    process.stdout.write(`${failed} check(s) failed\n`);
  } else {
    process.stdout.write("macOS network isolation: all checks passed\n");
  }
  // runSandbox leaves the shared egress proxy open for the rest of the process; this is a
  // one-shot check, so exit explicitly instead of waiting for that listener to go away.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
