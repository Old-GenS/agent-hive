/** hive's egress proxy: address vetting and the HTTP/HTTPS proxy itself (built by `npm run build`). */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { isPublicAddress, startEgressProxy } from "../dist/egress.js";

// Some sandboxed environments refuse connections to a port that bind(0) handed out, so find a
// free ephemeral port by number first and listen on that (the same workaround as
// test/release.test.mjs). The proxy takes an explicit port for the same reason.
async function freePort() {
  const probe = createTcpServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function listenOn(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

/** An http server that records the request it saw and answers with `body`. */
async function startTarget(body) {
  const server = createHttpServer((req, res) => {
    server.lastRequest = req;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(body);
  });
  return listenOn(server, await freePort());
}

/** A raw TCP echo server. */
async function startEcho() {
  const server = createTcpServer((socket) => socket.pipe(socket));
  return listenOn(server, await freePort());
}

function portOf(server) {
  return server.address().port;
}

/** startEgressProxy on a fixed, connectable port. */
async function startProxy(options) {
  return startEgressProxy({ ...options, port: await freePort() });
}

function proxyAuth(proxy) {
  const url = new URL(proxy.url);
  return `Basic ${Buffer.from(`hive:${url.password}`, "utf8").toString("base64")}`;
}

/** Send a raw CONNECT to the proxy and return the status code and the still-open socket. */
function connectThrough(proxy, authority, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxy.port });
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      cleanup();
      socket.pause();
      const status = Number(buffer.slice(9, 12));
      resolve({ socket, status, rest: buffer.slice(end + 4) });
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.once("connect", () => {
      const authLine = auth ? `Proxy-Authorization: ${proxyAuth(proxy)}\r\n` : "";
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authLine}\r\n`);
    });
  });
}

/** Read the next chunk from a paused socket (the CONNECT helper pauses it). */
function nextChunk(socket) {
  return new Promise((resolve) => {
    socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
    socket.resume();
  });
}

test("isPublicAddress allows public addresses and refuses everything else", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700::1111", "::ffff:1.1.1.1"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} must be public`);
  }
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:192.168.1.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ]) {
    assert.equal(isPublicAddress(ip), false, `${ip} must be refused`);
  }
});

test("proxy: auth, CONNECT tunnels and plain HTTP forwarding", async (t) => {
  const target = await startTarget("hello from the origin");
  const echo = await startEcho();
  const proxy = await startProxy({
    allow: () => true,
    lookup: async (host) => (host === "example.test" ? ["127.0.0.1"] : []),
  });
  t.after(async () => {
    await proxy.close();
    target.close();
    echo.close();
  });

  // No Proxy-Authorization: 407 with the Basic challenge.
  const unauth = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: proxy.port, path: `http://example.test:${portOf(target)}/x` },
      (res) => resolve(res),
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(unauth.statusCode, 407);
  assert.equal(unauth.headers["proxy-authenticate"], 'Basic realm="hive"');
  unauth.resume();

  // CONNECT through the proxy: 200, then raw bytes echo back.
  const tunnel = await connectThrough(proxy, `example.test:${portOf(echo)}`);
  assert.equal(tunnel.status, 200);
  tunnel.socket.write("ping through the tunnel");
  assert.equal(await nextChunk(tunnel.socket), "ping through the tunnel");
  tunnel.socket.destroy();

  // Plain absolute-form HTTP: the origin answers, and it sees the original Host header.
  const forwarded = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://example.test:${portOf(target)}/x`,
        headers: { "Proxy-Authorization": proxyAuth(proxy) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.body, "hello from the origin");
  assert.equal(target.lastRequest.headers.host, `example.test:${portOf(target)}`);
  assert.equal(target.lastRequest.headers["proxy-authorization"], undefined, "the proxy credential must not leak to the origin");
});

test("proxy: refuses non-public destinations, logs them and answers 502 when nothing resolves", async (t) => {
  const echo = await startEcho();
  const logs = [];
  const proxy = await startProxy({
    lookup: async (host) => {
      if (host === "loopback.test") return ["127.0.0.1"];
      if (host === "lan.test") return ["192.168.1.1"];
      if (host === "mixed.test") return ["1.1.1.1", "10.0.0.1"];
      throw new Error("NXDOMAIN");
    },
    log: (line) => logs.push(line),
  });
  t.after(async () => {
    await proxy.close();
    echo.close();
  });

  for (const authority of [`127.0.0.1:${portOf(echo)}`, "lan.test:443", "mixed.test:443"]) {
    const refused = await connectThrough(proxy, authority);
    assert.equal(refused.status, 403, `${authority} must be refused`);
    refused.socket.destroy();
  }
  assert.ok(logs.some((line) => line.startsWith("denied 127.0.0.1:")), "the loopback denial is logged");
  assert.ok(logs.some((line) => line === "denied lan.test:443 (192.168.1.1)"), "the LAN denial is logged");
  assert.ok(logs.some((line) => line === "denied mixed.test:443 (10.0.0.1)"), "any non-public answer is enough");

  const unresolved = await connectThrough(proxy, "nowhere.test:443");
  assert.equal(unresolved.status, 502);
  unresolved.socket.destroy();
});

test("proxy: env has the standard proxy variables", async (t) => {
  const proxy = await startProxy({ lookup: async () => [], allow: () => true });
  t.after(() => proxy.close());
  assert.deepEqual(Object.keys(proxy.env).sort(), [
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NODE_USE_ENV_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]);
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    assert.equal(proxy.env[name], proxy.url);
  }
  assert.equal(proxy.env.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(proxy.env.no_proxy, "localhost,127.0.0.1,::1");
  assert.equal(proxy.env.NODE_USE_ENV_PROXY, "1");
  assert.equal(proxy.env.GIT_CONFIG_KEY_0, "http.proxyAuthMethod");
  assert.equal(proxy.env.GIT_CONFIG_VALUE_0, "basic");
  assert.equal(proxy.url, `http://hive:${new URL(proxy.url).password}@127.0.0.1:${proxy.port}`);
});
