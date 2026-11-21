#!/usr/bin/env node
/**
 * Smoke-test a release bundle against a real microVM. Run it in the CI VM job after extracting the
 * app bundle and the VM rootfs:
 *
 *   HIVE_BUNDLE_ROOT=<extracted bundle> HIVE_ROOTFS=<rootfs dir> node scripts/vm-smoke.mjs
 *
 * (run `npm run build` first, so ../dist/sandbox.js exists). Prints `ok <name>` or
 * `FAIL <name>: <detail>` for every check and exits 1 when any failed.
 *
 * One VM runs the network checks (HTTPS works, the host's LAN and the cloud metadata address are
 * refused through the egress proxy, Chromium renders a page). A second run starts the bundled CLI
 * with a fake OpenRouter key: the model API must answer 401, proving the VM reached the network and
 * the key it was given is the only one it used.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

const bundle = process.env.HIVE_BUNDLE_ROOT;
if (!bundle) {
  process.stderr.write("vm-smoke: set HIVE_BUNDLE_ROOT to an extracted release bundle\n");
  process.exit(2);
}
const rootfs = process.env.HIVE_ROOTFS;
if (!rootfs) {
  process.stderr.write("vm-smoke: set HIVE_ROOTFS to the extracted VM rootfs\n");
  process.exit(2);
}
// The bundle ships the hardened launcher; config.ts reads HIVE_VM_BIN at import time.
process.env.HIVE_VM_BIN = process.env.HIVE_VM_BIN || join(bundle, "libexec", "hive-vm");

const cleanups = [];
let failures = 0;

function pass(name) {
  process.stdout.write(`ok ${name}\n`);
}

function fail(name, detail) {
  failures++;
  process.stdout.write(`FAIL ${name}: ${detail}\n`);
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    fail(name, errorText(err));
  }
}

/** Run `fn` after every check, whether they passed or not. */
function cleanup(fn) {
  cleanups.push(fn);
}

function privateIPv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const address = entry.address;
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (/^10\./.test(address)) return address;
      if (/^192\.168\./.test(address)) return address;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return address;
    }
  }
  return undefined;
}

/** An HTTP server on 0.0.0.0 that answers every request; resolves with its port. */
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

// The json line the in-VM script prints for each of its checks:
//   {"name":"https","ok":true,"detail":"200"}
const VM_CHECKS = ["https", "lan-refused", "metadata-refused", "chromium"];

const VM_SCRIPT = `
emit() {
  printf '{"name":"%s","ok":%s,"detail":"%s"}\\n' "$1" "$2" "$3"
}

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 https://example.com 2>/dev/null || true)
if [ "$code" = "200" ]; then emit https true "$code"; else emit https false "status $code"; fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "http://$LAN_IP:$LAN_PORT/" 2>/dev/null || true)
if curl -sS --noproxy '*' --max-time 5 "http://$LAN_IP:$LAN_PORT/" >/dev/null 2>&1; then direct=connected; else direct=refused; fi
if [ "$code" = "403" ] && [ "$direct" = "refused" ]; then
  emit lan-refused true "proxy $code, direct refused"
else
  emit lan-refused false "proxy $code, direct $direct"
fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 http://169.254.169.254/ 2>/dev/null || true)
if [ "$code" = "403" ]; then emit metadata-refused true "$code"; else emit metadata-refused false "status $code"; fi

dom=$(timeout 90 chromium-browser --headless --no-sandbox --disable-gpu --dump-dom https://example.com 2>/dev/null || true)
if printf '%s' "$dom" | grep -q "Example Domain"; then
  emit chromium true "Example Domain"
else
  emit chromium false "no Example Domain in the DOM"
fi
`;

async function checkRuntime() {
  const sandbox = await import("../dist/sandbox.js");
  const { libkrunChoice, libkrunLabel } = await import("../dist/libkrun.js");
  const { pastaChoice, pastaLabel } = await import("../dist/pasta.js");
  const runtime = sandbox.detectRuntime();
  if (runtime.isolation !== "microvm") {
    throw new Error(`isolation is ${runtime.isolation}${runtime.warning ? `: ${runtime.warning}` : ""}`);
  }
  process.stdout.write(`  libkrun: ${libkrunLabel(libkrunChoice())}\n`);
  process.stdout.write(`  pasta: ${pastaLabel(pastaChoice())}\n`);
  pass("runtime");
}

async function checkVm() {
  const { runSandbox } = await import("../dist/sandbox.js");
  const work = mkdtempSync(join(tmpdir(), "hive-vm-smoke-"));
  cleanup(() => rmSync(work, { recursive: true, force: true }));

  const lanIp = privateIPv4();
  if (lanIp === undefined) throw new Error("no non-internal private IPv4 address on this host");
  const server = await lanServer();
  cleanup(() => server.close());
  const lanPort = server.address().port;
  // From the host, the server must answer on that address: the check is only meaningful then.
  const answer = await fetch(`http://${lanIp}:${lanPort}/`);
  if (!answer.ok) throw new Error(`host LAN server did not answer on ${lanIp}:${lanPort}`);

  const events = new Map();
  const ioDir = join(work, "io");
  mkdirSync(ioDir, { recursive: true });
  const handle = await runSandbox({
    name: "vm-smoke",
    mounts: [],
    env: { LAN_IP: lanIp, LAN_PORT: String(lanPort) },
    command: ["bash", "-c", VM_SCRIPT],
    ioDir,
    onEvent: (event) => {
      if (event && typeof event.name === "string") events.set(event.name, event);
    },
  });
  cleanup(() => handle.stop());
  const result = await handle.done;

  let bootNote = "";
  if (result.code !== 0 || result.timedOut) {
    bootNote = ` (vm exit ${result.code}${result.timedOut ? ", timed out" : ""}: ${result.stderr.split("\n")[0] ?? ""})`;
  }
  for (const name of VM_CHECKS) {
    const event = events.get(name);
    if (event === undefined) {
      fail(name, `no result from the VM${bootNote}`);
    } else if (event.ok === true) {
      pass(name);
    } else {
      fail(name, String(event.detail ?? "no detail"));
    }
  }
}

/**
 * A second VM on the direct network (pasta's own, HIVE_NETWORK=direct), where the guest resolves
 * names itself. The proxied VM never does DNS (the proxy resolves on the host), so this is the
 * check that catches a guest-kernel DNS regression like libkrunfw 5.6.4's.
 */
async function checkDirectDns() {
  const { config } = await import("../dist/config.js");
  const { runSandbox } = await import("../dist/sandbox.js");
  const work = mkdtempSync(join(tmpdir(), "hive-vm-smoke-dns-"));
  cleanup(() => rmSync(work, { recursive: true, force: true }));
  const ioDir = join(work, "io");
  mkdirSync(ioDir, { recursive: true });
  const before = config.sandbox.network;
  config.sandbox.network = "direct";
  let handle;
  try {
    handle = await runSandbox({
      name: "vm-smoke-dns",
      mounts: [],
      env: {},
      command: [
        "bash",
        "-c",
        'if out=$(getent hosts example.com); then echo "dns-ok $out"; else echo "dns-failed"; fi',
      ],
      ioDir,
    });
  } finally {
    config.sandbox.network = before;
  }
  cleanup(() => handle.stop());
  const result = await handle.done;
  const out = readText(join(ioDir, "events.jsonl")).trim();
  if (!out.startsWith("dns-ok")) {
    throw new Error(`no DNS in the VM on the direct network: ${out || `vm exit ${result.code}`}`);
  }  pass("direct-dns");
}

/** Run a shell-free command to completion with a timeout, collecting stdout+stderr. */
function run(command, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** Every file under `dir`, newest first, as absolute paths. */
function newestDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function checkFakeKeyRun() {
  const work = mkdtempSync(join(tmpdir(), "hive-vm-smoke-run-"));
  cleanup(() => rmSync(work, { recursive: true, force: true }));
  const repo = join(work, "repo");
  const home = join(work, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(home, ".config"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# smoke test\n");
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git(["init"]);
  git(["config", "user.name", "ci"]);
  git(["config", "user.email", "ci@example.invalid"]);
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);

  const runsDir = join(home, ".cache", "agent-hive", "runs");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    HIVE_KEYS_FILE: join(home, ".config", "agent-hive", "env"),
    HIVE_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    OPENROUTER_API_KEY: "sk-or-v1-ci-fake",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  const result = await run(
    join(bundle, "bin", "hive"),
    ["run", "-p", "openrouter", "List the files in this repository and say hello."],
    { cwd: repo, env },
    10 * 60 * 1000,
  );
  if (result.timedOut) throw new Error("the fake-key run did not finish within 10 minutes");

  // The run's events and the VM's stderr live in the run folder; the CLI's own output is in
  // `result.output`. Both count as the run's logs/output.
  const [runDir] = newestDirs(runsDir);
  const logs = [result.output];
  if (runDir !== undefined) {
    logs.push(readText(join(runDir, "io", "events.jsonl")), readText(join(runDir, "io", "stderr.log")));
    for (const entry of readdirSync(join(runDir, "io"))) {
      if (/^events-.*\.jsonl$/.test(entry) || /^stderr-.*\.log$/.test(entry)) {
        logs.push(readText(join(runDir, "io", entry)));
      }
    }
  }
  const text = logs.join("\n");
  const network = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|getaddrinfo/.exec(text);
  if (network !== null) {
    throw new Error(`a network error got in the way: ${network[0]}`);
  }
  const authLine = text
    .split("\n")
    .find((line) => /401|unauthori[sz]ed|invalid.{0,20}(api )?key|no auth|user not found/i.test(line));
  if (authLine === undefined) {
    throw new Error("the fake key was not rejected with an authentication error");
  }
  pass("fake-key-run");
  process.stdout.write(`  ${authLine.trim().slice(0, 300)}\n`);
}

async function main() {
  await check("runtime", checkRuntime);
  try {
    await checkVm();
  } catch (err) {
    for (const name of VM_CHECKS) fail(name, errorText(err));
  }
  await check("direct-dns", checkDirectDns);
  try {
    await checkFakeKeyRun();
  } catch (err) {
    fail("fake-key-run", errorText(err));
  }
}

try {
  await main();
} finally {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

process.exitCode = failures === 0 ? 0 : 1;
if (failures > 0) process.stdout.write(`${failures} check(s) failed\n`);
