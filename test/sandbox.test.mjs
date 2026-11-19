/** Server-side sandbox command building for the libkrun backend (built by `npm run build`). */
import test from "node:test";
import assert from "node:assert/strict";
import { buildLibkrunCommand, hostNameserver, parseMemoryMiB } from "../dist/sandbox.js";

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
    { vmBin: "/opt/hive-vm", rootfs: "/r", cpus: 1, memoryMiB: 1024, hostDns: "127.0.0.53" },
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
    "--share", "/h/work:/work",
    "--share", "/h/s:/session:ro",
    "--env", "OPENROUTER_API_KEY",
    "--dns", "169.254.1.53",
    "--workdir", "/work",
    "--", "hive-agent", "--model", "m",
  ]);
  assert.ok(!cmd.args.join(" ").includes("sk-or-secret"));
});
