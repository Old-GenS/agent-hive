#!/usr/bin/env node
/**
 * A tiny host-side vsock endpoint for the Phase 0 checks.
 *
 *   node scripts/macos-spike/vsock-probe.mjs echo /tmp/hv-echo.sock
 *   node scripts/macos-spike/vsock-probe.mjs sink /tmp/hv-sink.sock
 *
 * "echo" pipes every byte back (the guest checks bytes make the round trip);
 * "sink" reads and reports MiB/s (the guest checks throughput).
 */
import { createServer } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";

const mode = process.argv[2];
const socketPath = process.argv[3] || (mode === "echo" ? "/tmp/hv-echo.sock" : "/tmp/hv-sink.sock");
if (mode !== "echo" && mode !== "sink") {
  console.error("usage: vsock-probe.mjs echo|sink [socket-path]");
  process.exit(2);
}

try {
  unlinkSync(socketPath);
} catch {
  // no stale socket
}

const server = createServer((socket) => {
  socket.on("error", () => {});

  if (mode === "echo") {
    socket.pipe(socket);
    return;
  }

  let bytes = 0;
  let done = false;
  const started = Date.now();
  const report = () => {
    if (done) return;
    done = true;
    const ms = Date.now() - started;
    const mib = bytes / (1024 * 1024);
    console.log("SINK bytes=" + bytes + " mib=" + mib.toFixed(1) + " ms=" + ms +
                " mibps=" + (mib / (ms / 1000)).toFixed(1));
  };
  socket.on("data", (data) => { bytes += data.length; });
  socket.on("end", report);
  socket.on("close", report);
});

server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  console.log("PROBE_READY " + JSON.stringify({ mode, socket: socketPath }));
});

const close = () => {
  server.close();
  try {
    unlinkSync(socketPath);
  } catch {
    // already gone
  }
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
