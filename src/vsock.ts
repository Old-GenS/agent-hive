/**
 * The macOS host side of vsock-only egress.
 *
 * The libkrun launcher maps one guest vsock port to a short UNIX socket (krun_add_vsock_port) and
 * runs with the implicit TSI device disabled, so the guest has no IP network at all. This module
 * creates that socket and pipes every connection to hive's egress proxy on the host's loopback.
 * The proxy still vets each destination and connects by address, so a VM can reach HTTP and HTTPS
 * and nothing else: not this computer, not the local network, and no DNS of its own.
 *
 * Inside the VM, hive-netd listens on 127.0.0.1:3128 and relays each connection over the vsock
 * port. That is why the guest's proxy variables point at its own loopback, not the host's port.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";

/** The proxy port hive-netd listens on inside the VM; every tool in the VM is told to use it. */
export const GUEST_PROXY_PORT = 3128;

/** The vsock port the launcher maps to the bridge socket; hive-netd connects to it. */
export const VSOCK_PORT = 1024;

/** macOS sun_path holds 104 bytes including the terminating NUL. */
export const MAX_SOCKET_PATH = 103;

export interface VsockBridge {
  /** The short UNIX socket path handed to the launcher's --vsock. */
  socketPath: string;
  /** Drop every connection, close the listener and remove the socket. Idempotent. */
  close(): Promise<void>;
}

export interface BridgeOptions {
  /** Directory for the socket; /tmp is short and exists on every Mac. */
  dir?: string;
  /** Connection cap, so a runaway guest cannot exhaust the host's file descriptors. */
  maxConnections?: number;
}

/** A fresh short path: "hv-" plus 12 random hex digits, 22 bytes under /tmp. */
export function bridgeSocketPath(dir: string): string {
  return join(dir, "hv-" + randomBytes(6).toString("hex") + ".sock");
}

/**
 * Refuse to replace anything that is not a socket. /tmp is world-writable, so a planted link or
 * file at our path must fail the bridge instead of being deleted or followed.
 */
function removeStaleSocket(path: string): void {
  try {
    const st = lstatSync(path);
    if (!st.isSocket()) throw new Error("refusing to replace " + path + ": not a UNIX socket");
    rmSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Listen on a fresh socket and pipe each accepted connection to the egress proxy at proxyPort.
 * The caller must close the bridge when the VM exits; the socket file is removed then.
 */
export async function startVsockBridge(proxyPort: number, o: BridgeOptions = {}): Promise<VsockBridge> {
  const socketPath = bridgeSocketPath(o.dir ?? process.env.HIVE_VSOCK_DIR ?? "/tmp");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error("vsock bridge socket path is too long for sun_path: " + socketPath);
  }
  removeStaleSocket(socketPath);
  const sockets = new Set<Socket>();
  const maxConnections = o.maxConnections ?? 256;
  // Set before every socket is destroyed, so a connection accepted mid-close is dropped instead of
  // keeping server.close()'s callback (and the bridge) alive.
  let shuttingDown = false;
  const server = createServer((client) => {
    if (shuttingDown || sockets.size >= maxConnections) {
      client.destroy();
      return;
    }
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const upstream = connect({ host: "127.0.0.1", port: proxyPort });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.once("close", () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  } catch (err) {
    rmSync(socketPath, { force: true });
    throw err;
  }
  // The socket is ours alone: hive-vm runs as this user, and no other account should connect.
  chmodSync(socketPath, 0o600);
  // Like the egress proxy: never keep the process alive for the bridge's sake.
  server.unref();

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    shuttingDown = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    closing = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(socketPath, { force: true });
    return closing;
  };
  return { socketPath, close };
}
