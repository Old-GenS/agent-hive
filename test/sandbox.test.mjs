/** Server-side sandbox command building for the libkrun backend (built by `npm run build`). */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SHARES, buildLibkrunCommand, hostNameserver, parseMemoryMiB, runSandbox } from "../dist/sandbox.js";

test("parseMemoryMiB", () => {
  assert.equal(parseMemoryMiB("512m"), 512);
  assert.equal(parseMemoryMiB("1g"), 1024);
  assert.equal(parseMemoryMiB("2G"), 2048);
  assert.equal(parseMemoryMiB("768"), 768);
  assert.throws(() => parseMemoryMiB("lots"));
});

test("hostNameserver picks the first IPv4 nameserver", () => {
  assert.equal(hostNameserver("nameserver 127.0.0.53\n"), "127.0.0.53");
  assert.equal(hostNameserver("nameserver fe80::1\nnameserver 10.0.0.1\n"), "10.0.0.1");
  assert.equal(hostNameserver(""), "1.1.1.1");
});

test("buildLibkrunCommand wraps hive-vm in pasta and never leaks env values", () => {
  const cmd = buildLibkrunCommand(
    {
      name: "hive-test",
      mounts: [
        { host: "/h/work", container: "/work" },
        { host: "/h/s", container: "/session", ro: true },
      ],
      env: { OPENROUTER_API_KEY: "sk-or-secret" },
      command: ["hive-agent", "--model", "m"],
    },
    {
      vmBin: "/opt/hive-vm",
      rootfs: "/r",
      cpus: 1,
      memoryMiB: 1024,
      hostDns: "127.0.0.53",
      timeoutSec: 3600,
      stderrFile: "/runs/io.launcher.log",
    },
  );
  assert.equal(cmd.file, "pasta");
  assert.deepEqual(cmd.args, [
    "--config-net", "-q", "-T", "none", "-U", "none", "--no-map-gw",
    "--dns-forward", "169.254.1.53",
    "--dns-host", "127.0.0.53",
    "--", "/usr/bin/env", "/opt/hive-vm",
    "--rootfs", "/r",
    "--cpus", "1",
    "--memory", "1024",
    "--timeout", "3600",
    "--stderr-file", "/runs/io.launcher.log",
    "--share", "/h/work:/work",
    "--share", "/h/s:/session:ro",
    "--env", "OPENROUTER_API_KEY",
    "--dns", "169.254.1.53",
    "--workdir", "/work",
    "--", "hive-agent", "--model", "m",
  ]);
  assert.ok(cmd.args.includes("--timeout"), "the launcher must enforce the time limit");
  assert.equal(cmd.args[cmd.args.indexOf("--timeout") + 1], "3600");
  assert.ok(!cmd.args.join(" ").includes("sk-or-secret"));
});

test("resetIoDir keeps prompt files, empties the logs and never writes through a symlink", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, symlinkSync, lstatSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resetIoDir } = await import("../dist/sandbox.js");
  const dir = mkdtempSync(join(tmpdir(), "hive-io-reset-"));
  const io = join(dir, "io");
  resetIoDir(io);
  writeFileSync(join(io, "prompt.md"), "the task");
  writeFileSync(join(io, "stderr.log"), "old errors");
  const hostFile = join(dir, "host-file");
  writeFileSync(hostFile, "keep me");
  // the agent replaces events.jsonl with a link to a host file
  rmSync(join(io, "events.jsonl"));
  symlinkSync(hostFile, join(io, "events.jsonl"), "file");
  resetIoDir(io);
  assert.equal(readFileSync(join(io, "prompt.md"), "utf8"), "the task");
  assert.equal(readFileSync(join(io, "stderr.log"), "utf8"), "");
  assert.equal(lstatSync(join(io, "events.jsonl")).isSymbolicLink(), false);
  assert.equal(readFileSync(hostFile, "utf8"), "keep me");
});

test("runSandbox refuses more shared folders than libkrun supports", () => {
  assert.equal(MAX_SHARES, 5);
  const ioDir = join(mkdtempSync(join(tmpdir(), "hive-shares-")), "io");
  const mounts = Array.from({ length: MAX_SHARES }, (_, i) => ({ host: `/h/${i}`, container: `/m${i}` }));
  // MAX_SHARES mounts plus the /io share runSandbox adds is one too many: fail before anything starts.
  assert.throws(
    () => runSandbox({ name: "hive-test", mounts, env: {}, command: ["true"], ioDir }),
    /too many shared folders for one VM: 6 \(libkrun supports 5\)/,
  );
  assert.equal(existsSync(ioDir), false, "the throw must happen before the io folder or a VM is created");
});
