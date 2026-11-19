import dotenv from "dotenv";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config(process.env.HIVE_DOTENV_PATH ? { path: process.env.HIVE_DOTENV_PATH } : undefined);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

/** LLM providers: which env var holds the key on the host, which name pi expects in the sandbox. */
export const PROVIDERS: Record<string, { hostEnv: string[]; sandboxEnv: string; defaultModel?: string }> = {
  deepseek: { hostEnv: ["DEEPSEEK_API_KEY"], sandboxEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-v4-pro" },
  zai: { hostEnv: ["ZAI_API_KEY", "ZAI_CODE"], sandboxEnv: "ZAI_API_KEY", defaultModel: "glm-5.3" },
  openrouter: { hostEnv: ["OPENROUTER_API_KEY"], sandboxEnv: "OPENROUTER_API_KEY", defaultModel: "xiaomi/mimo-v2.6-flash" },
  anthropic: { hostEnv: ["ANTHROPIC_API_KEY"], sandboxEnv: "ANTHROPIC_API_KEY" },
  openai: { hostEnv: ["OPENAI_API_KEY"], sandboxEnv: "OPENAI_API_KEY" },
};

export function providerKey(provider: string): string | undefined {
  const p = PROVIDERS[provider];
  if (!p) return undefined;
  for (const name of p.hostEnv) if (process.env[name]) return process.env[name];
  return undefined;
}

/** explicit > DEFAULT_PROVIDER > first provider with a key configured. */
export function resolveProvider(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.DEFAULT_PROVIDER) return process.env.DEFAULT_PROVIDER;
  return Object.keys(PROVIDERS).find((p) => providerKey(p));
}

export const config = {
  port: int("PORT", 8080),
  host: process.env.HOST || "127.0.0.1",
  workspace: resolve(process.env.WORKSPACE || "/tmp/hive-workspace"),
  maxConcurrent: int("MAX_CONCURRENT_SESSIONS", 2),
  maxQueued: int("MAX_QUEUED_SESSIONS", 10),
  idleTimeoutMs: int("SESSION_IDLE_TIMEOUT_MS", 30 * 60_000),
  defaultModel: process.env.DEFAULT_MODEL || "",
  defaultThinking: process.env.DEFAULT_THINKING || "low",
  systemPrompt:
    process.env.HIVE_SYSTEM_PROMPT ||
    "You are a senior software developer. Be direct and concise, show code, skip filler. Don't gold-plate, but don't leave it half-done. Check multiple locations and follow the project's conventions. Flag risks. If unsure, say so.",
  runsDir: resolve(process.env.HIVE_RUNS_DIR || join(cacheHome, "agent-hive/runs")),
  sandbox: {
    image: process.env.HIVE_IMAGE || "localhost/agent-hive-sandbox:latest",
    runtime: process.env.HIVE_RUNTIME || "auto", // auto | libkrun | krun | runsc | crun | runc
    memory: process.env.HIVE_SANDBOX_MEMORY || "1g",
    cpus: process.env.HIVE_SANDBOX_CPUS || "1",
    timeoutMin: int("HIVE_SANDBOX_TIMEOUT_MIN", 60),
    vmBin: process.env.HIVE_VM_BIN || resolve(repoRoot, "vm/hive-vm"),
    rootfs: process.env.HIVE_ROOTFS || join(dataHome, "agent-hive/rootfs/current"),
    libkrun: process.env.HIVE_LIBKRUN || "libkrun.so.1",
    // Shared npm cache for the agent's downloads; exempt from the per-task sandbox isolation.
    // HIVE_NPM_CACHE="" disables it.
    npmCache: process.env.HIVE_NPM_CACHE ?? join(cacheHome, "agent-hive/npm"),
  },
  git: {
    authorName: process.env.GIT_AUTHOR_NAME || "agent-hive",
    authorEmail: process.env.GIT_AUTHOR_EMAIL || "agent-hive@users.noreply.github.com",
    branchPrefix: process.env.HIVE_BRANCH_PREFIX || "hive/",
    // Only for local testing: accept repo URLs other than github.com (file paths, other hosts).
    allowAnyRepoUrl: process.env.HIVE_ALLOW_ANY_REPO_URL === "1",
  },
};
