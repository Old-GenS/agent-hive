import { config } from "./config.js";
import Fastify from "fastify";
import fWebSocket from "@fastify/websocket";
import fStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTokens, requireAuth } from "./auth.js";
import { checkSandbox, runtimeInfo } from "./sandbox.js";
import { capacity, default as webRunRoutes } from "./web-runs.js";
import { pruneRuns, recoverRuns } from "./runs.js";
import { uiDistCandidates } from "./release.js";
import githubRoutes from "./routes/github.js";
import providerRoutes from "./routes/providers.js";
import systemRoutes from "./routes/system.js";
import keyRoutes from "./routes/keys.js";
import settingsRoutes from "./routes/settings.js";
import onboardingRoutes from "./routes/onboarding.js";

let tokenCount = 0;
try {
  tokenCount = loadTokens();
} catch (err) {
  console.error(`FATAL: ${(err as Error).message}`);
  process.exit(1);
}
if (!tokenCount) {
  console.error(
    "FATAL: no API token. Run hive serve (it creates one), or set API_TOKEN in .env or ~/.config/agent-hive/env; generate one with: openssl rand -hex 32",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

await app.register(fWebSocket);

// ── public: UI assets, health ──
const uiDist = uiDistCandidates(process.env, here).find((candidate) => existsSync(candidate));
if (uiDist !== undefined) {
  await app.register(fStatic, { root: uiDist, prefix: "/ui/", decorateReply: false });
  app.get("/ui", (_req, reply) => reply.redirect("/ui/"));
} else {
  app.log.warn("ui/dist not found; build the UI with: npm run build:ui");
}
app.get("/", (_req, reply) => reply.redirect("/ui/"));
app.get("/docs", (_req, reply) => reply.redirect("/ui/"));
app.get("/health", async () => ({
  status: "ok",
  uptime: Math.floor(process.uptime()),
  isolation: runtimeInfo.isolation,
}));

// ── API: everything registered in this scope requires auth ──
await app.register(async (api) => {
  api.addHook("onRequest", requireAuth);
  api.get("/capacity", async () => capacity());
  await api.register(webRunRoutes);
  await api.register(githubRoutes);
  await api.register(providerRoutes);
  await api.register(systemRoutes);
  await api.register(keyRoutes);
  await api.register(settingsRoutes);
  await api.register(onboardingRoutes);
});

for (const problem of checkSandbox()) app.log.error(problem);
app.log.info(`sandbox isolation: ${runtimeInfo.isolation} (${runtimeInfo.runtime})`);
if (runtimeInfo.warning) app.log.warn(runtimeInfo.warning);

// A run whose owner died (a crashed hive, a reboot) never finished: stop its leftover VM, mark it
// failed, then drop finished runs past HIVE_RUN_RETENTION_DAYS (and keep doing so every 6 hours).
const recovered = recoverRuns();
app.log.info(`startup cleanup: recovered ${recovered.length} interrupted run(s)`);
const pruned = pruneRuns();
app.log.info(`startup cleanup: pruned ${pruned.length} old run(s)`);
setInterval(() => {
  try {
    const names = pruneRuns();
    if (names.length > 0) app.log.info(`pruned ${names.length} old run(s): ${names.join(", ")}`);
  } catch (err) {
    app.log.error(err);
  }
}, 6 * 60 * 60_000).unref();

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
