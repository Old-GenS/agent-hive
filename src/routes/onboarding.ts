/**
 * First-run onboarding: one call that says whether setup is needed, the checks with their fixes,
 * the key and GitHub state, and the rootfs download state; plus starting that download from the
 * web UI. Registered in the authenticated scope in index.ts.
 *
 * The download state lives in memory for this server process. A release has at most one VM
 * filesystem, so one download at a time is enough; the UI polls GET /api/onboarding for progress.
 */
import type { FastifyInstance } from "fastify";
import { providerInfo } from "../config.js";
import { bundleRoot, setupRootfs } from "../release.js";
import { systemInfo } from "../sandbox.js";
import { hostInfo } from "../fixes.js";
import { githubStatus } from "./system.js";

type DownloadState = {
  state: "idle" | "downloading" | "done" | "error";
  received: number;
  total: number | undefined;
  error?: string;
};

let download: DownloadState = { state: "idle", received: 0, total: undefined };

/** The rootfs check from systemInfo, which carries the distro-aware fix. */
function rootfsCheck() {
  return systemInfo().checks.find((check) => check.id === "rootfs");
}

/** Only an installed release can fetch its VM filesystem, and only when it is missing. */
function canDownload(): boolean {
  return bundleRoot() !== undefined && rootfsCheck()?.ok === false;
}

export default async function onboardingRoutes(app: FastifyInstance) {
  app.get("/api/onboarding", async () => {
    const info = systemInfo();
    const providers = providerInfo();
    const hasKey = providers.providers.some((provider) => provider.hasKey);
    const host = hostInfo();
    const github = await githubStatus();
    const rootfs = info.checks.find((check) => check.id === "rootfs");
    const rootfsOk = rootfs?.ok === true;
    return {
      // Setup is needed when there is no model key yet, or a check fails.
      needed: !hasKey || info.checks.some((check) => !check.ok),
      checks: info.checks,
      hasKey,
      defaultProvider: providers.default.provider,
      github: github.connected ? { connected: true, login: github.login } : { connected: false },
      host: { distro: host.distro, wsl: host.wsl, bundle: host.bundle },
      rootfs: {
        ok: rootfsOk,
        canDownload: bundleRoot() !== undefined && !rootfsOk,
        download,
      },
    };
  });

  app.post("/api/setup/rootfs", async (_req, reply) => {
    if (download.state === "downloading") {
      return reply.code(409).send({ error: "A VM filesystem download is already running" });
    }
    if (!canDownload()) {
      return reply.code(409).send({
        error:
          bundleRoot() === undefined
            ? process.platform === "darwin"
              ? "macOS needs an arm64 VM image, which this build does not produce yet (docs/MACOS.md, Phase 2)"
              : "Downloading the VM filesystem needs an installed release; build it from source with npm run build:image && npm run build:rootfs"
            : "The VM filesystem is already installed",
      });
    }
    const onProgress = (progress: { received: number; total: number | undefined }): void => {
      download.received = progress.received;
      download.total = progress.total;
    };
    download = { state: "downloading", received: 0, total: undefined };
    setupRootfs({ onProgress })
      .then(() => {
        download = { ...download, state: "done" };
      })
      .catch((err: unknown) => {
        download = {
          ...download,
          state: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      });
    return reply.code(202).send({ state: "downloading" });
  });
}
