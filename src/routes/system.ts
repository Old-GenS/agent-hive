/**
 * What this server runs sandboxes with (a libkrun microVM), the checks behind it, VM size,
 * capacity, live usage and git transport, for the UI's Settings > This computer page. Paths and
 * numbers only; no secrets.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { githubLogin } from "../git.js";
import { githubScopes } from "../github-login.js";
import { currentVersion } from "../release.js";
import { systemInfo } from "../sandbox.js";
import { usageNow } from "../usage.js";
import { capacity } from "../web-runs.js";
import { hostname } from "node:os";

/** Whether the server's gh login works, as whom, and whether it may push `.github/workflows`. */
export async function githubStatus(): Promise<{
  connected: boolean;
  login?: string;
  error?: string;
  scopes?: string[];
  canPushWorkflows: boolean | null;
}> {
  let login: string;
  try {
    login = await githubLogin();
  } catch (err) {
    return { connected: false, error: (err as Error).message, canPushWorkflows: null };
  }
  const scopes = await githubScopes();
  return {
    connected: true,
    login,
    ...(scopes ? { scopes } : {}),
    // Unknown (no scope line: a fine-grained token) is not the same as missing.
    canPushWorkflows: scopes ? scopes.includes("workflow") : null,
  };
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
    // `vmCache` is the current name; `npmCache` is kept because the UI reads it.
    vmCache: Boolean(config.sandbox.vmCache),
    npmCache: Boolean(config.sandbox.vmCache),
    version: currentVersion() ?? "dev (from source)",
  }));

  // The "Right now" tiles on the same page; polled every few seconds while it is open.
  app.get("/api/system/usage", async () => ({
    ...(await usageNow()),
    hostname: hostname(),
    runs: capacity(),
  }));
}
