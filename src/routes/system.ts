/**
 * What this server runs sandboxes with (microVM via libkrun, podman with krun or gVisor, or plain
 * containers), the checks behind it, VM size, capacity and git transport, for the UI's
 * Settings > This computer page. Paths only; no secrets.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { githubLogin } from "../git.js";
import { currentVersion } from "../release.js";
import { systemInfo } from "../sandbox.js";
import { capacity } from "../tasks.js";

/** Whether the server's gh login works, and as whom. */
async function githubStatus(): Promise<{ connected: boolean; login?: string; error?: string }> {
  try {
    return { connected: true, login: await githubLogin() };
  } catch (err) {
    return { connected: false, error: (err as Error).message };
  }
}

export default async function systemRoutes(app: FastifyInstance) {
  app.get("/api/system", async () => ({
    ...systemInfo(),
    github: await githubStatus(),
    vm: {
      memory: config.sandbox.memory,
      cpus: config.sandbox.cpus,
      timeoutMin: config.sandbox.timeoutMin,
    },
    capacity: capacity(),
    gitProtocol: config.git.protocol,
    npmCache: Boolean(config.sandbox.npmCache),
    version: currentVersion() ?? "dev (from source)",
  }));
}
