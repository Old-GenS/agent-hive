// The macOS host side of vsock-only egress: short socket paths, a working relay to the proxy, and
// a socket that goes away with the bridge. Socket directories live directly under /tmp: sun_path
// is 104 bytes, and the test runner's TMPDIR is often too long on macOS. Every test has a deadline
// and closes what it opened, so a failure can never hang the suite.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";

const { GUEST_PROXY_PORT, MAX_SOCKET_PATH, VSOCK_PORT, bridgeSocketPath, startVsockBridge } = await import(
  "../dist/vsock.js"
);

const DEADLINE = 10_000;

function shortDir() {
  return mkdtempSync("/tmp/hive-vsock-");
}

// A TCP echo server that tracks its connections, so a test can always stop it. net.Server has no
// closeAllConnections(): a leaked connection would keep both the server and the test process alive.
async function echoServer() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test("the guest and launcher ports are the ones the image and docs use", () => {
  assert.equal(GUEST_PROXY_PORT, 3128);
  assert.equal(VSOCK_PORT, 1024);
});

test("bridgeSocketPath is short, unique and inside its directory", () => {
  const first = bridgeSocketPath("/tmp");
  const second = bridgeSocketPath("/tmp");
  assert.match(first, /^\/tmp\/hv-[0-9a-f]{12}\.sock$/);
  assert.notEqual(first, second);
  assert.ok(Buffer.byteLength(first) <= MAX_SOCKET_PATH);
});

test("startVsockBridge relays both ways and removes its socket", { timeout: DEADLINE }, async () => {
  const echo = await echoServer();
  const dir = shortDir();
  let bridge;
  try {
    bridge = await startVsockBridge(echo.port, { dir });
    assert.ok(existsSync(bridge.socketPath), "the socket exists while the bridge is up");
    const received = await new Promise((resolve, reject) => {
      const client = connect(bridge.socketPath);
      const timer = setTimeout(() => reject(new Error("no echo through the bridge")), 5_000);
      let data = "";
      client.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      client.on("data", (chunk) => {
        // A stream may deliver the echo in more than one chunk under load.
        data += chunk.toString("utf8");
        if (data.length >= "hello-vsock".length) {
          clearTimeout(timer);
          client.end();
          resolve(data);
        }
      });
      client.write("hello-vsock");
    });
    assert.equal(received, "hello-vsock");
  } finally {
    if (bridge) {
      await bridge.close();
      assert.equal(existsSync(bridge.socketPath), false, "close() removes the socket");
    }
    await echo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close() is idempotent", { timeout: DEADLINE }, async () => {
  const echo = await echoServer();
  const dir = shortDir();
  let bridge;
  try {
    bridge = await startVsockBridge(echo.port, { dir });
    await bridge.close();
    await bridge.close();
    assert.equal(existsSync(bridge.socketPath), false);
  } finally {
    await echo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startVsockBridge refuses a path too long for sun_path", { timeout: DEADLINE }, async () => {
  const dir = "/tmp/" + "x".repeat(120);
  await assert.rejects(startVsockBridge(1, { dir }), /too long for sun_path/);
  assert.equal(existsSync(join(dir, "hv-nothing.sock")), false);
});
