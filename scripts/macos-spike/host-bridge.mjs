#!/usr/bin/env node
/**
 * The Phase 0 host side of vsock-only egress.
 *
 * Starts hive's real egress proxy (src/egress.ts, built to dist/egress.js), then
 * listens on a short UNIX socket. libkrun's krun_add_vsock_port maps the guest's
 * vsock port to that socket; every connection is piped to the proxy's loopback
 * port. The guest still has no IP network and the proxy still vets every
 * destination, exactly as in the pasta path.
 *
 * Usage: node scripts/macos-spike/host-bridge.mjs [--socket /tmp/hv-XXXX.sock] [--debug]
 * Requires: npm run build (for dist/egress.js).
 */
import { createServer, connect } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { startEgressProxy } from "../../dist/egress.js";

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const socketPath = argValue("--socket", "/tmp/hv-spike.sock");
const debug = process.argv.includes("--debug") || process.env.HIVE_EGRESS_DEBUG === "1";

if (Buffer.byteLength(socketPath) >= 104) {
  console.error("socket path must be shorter than 104 bytes: " + socketPath);
  process.exit(2);
}

try {
  unlinkSync(socketPath);
} catch {
  // no stale socket
}

const proxy = await startEgressProxy({
  log: debug ? (line) => console.error("[egress] " + line) : undefined,
});

const clients = new Set();
const server = createServer((client) => {
  clients.add(client);
  client.once("close", () => clients.delete(client));
  client.on("error", () => client.destroy());

  const upstream = connect({ host: "127.0.0.1", port: proxy.port });
  upstream.on("error", () => client.destroy());
  upstream.once("close", () => client.destroy());
  client.pipe(upstream).pipe(client);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    resolve();
  });
});

console.log("BRIDGE_READY " + JSON.stringify({
  socket: socketPath,
  proxyPort: proxy.port,
  proxyUrl: proxy.url,
}));

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  for (const client of clients) client.destroy();
  clients.clear();
  server.close();
  await proxy.close();
  try {
    unlinkSync(socketPath);
  } catch {
    // already gone
  }
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
