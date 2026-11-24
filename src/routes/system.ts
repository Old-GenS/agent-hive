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
import { systemInfo, vmFilesystemInfo } from "../sandbox.js";
import { libkrunChoice, libkrunLabel } from "../libkrun.js";
import { pastaChoice, pastaLabel } from "../pasta.js";
import { readFileSync } from "node:fs";
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

/**
 * The version to show: a release's own VERSION, or the checkout's package.json marked as source.
 * "dev" told the reader nothing about which code they were looking at.
 */
function versionLabel(): string {
  const released = currentVersion();
  if (released) return released;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string") return `${pkg.version} (from source)`;
  } catch {
    // A bundle without package.json: the VERSION file is the answer, and that path is above.
  }
  return "unknown";
}

/** What the sandbox is made of, and which versions of each piece this server would use. */
function components(): {
  libkrun: string;
  pasta: string;
  vmImage: { id?: string; distro?: string; ok: boolean };
} {
  const libkrun = libkrunChoice();
  const pasta = pastaChoice();
  const image = vmFilesystemInfo();
  return {
    libkrun: `${libkrunLabel(libkrun)}${libkrun.ok ? "" : " (not usable)"}`,
    pasta: `${pastaLabel(pasta)}${pasta.ok ? "" : " (not usable)"}`,
    vmImage: { id: image.id, distro: image.distro, ok: image.ok },
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
    version: versionLabel(),
    components: components(),
  }));

  // The "Right now" tiles on the same page; polled every few seconds while it is open.
  app.get("/api/system/usage", async () => ({
    ...(await usageNow()),
    hostname: hostname(),
    runs: capacity(),
  }));
}
