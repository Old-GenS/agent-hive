import dotenv from "dotenv";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keySource, readKeysFile } from "./keys.js";

export { keysFilePath } from "./keys.js";

// The variables the process really started with, captured before dotenv adds the server's .env.
// They win over saved keys and over .env values.
export const shellEnv: Readonly<Record<string, string | undefined>> = { ...process.env };

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
export const PROVIDERS: Record<
  string,
  { hostEnv: string[]; sandboxEnv: string; defaultModel?: string; label: string }
> = {
  deepseek: {
    hostEnv: ["DEEPSEEK_API_KEY"],
    sandboxEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-flash",
    label: "DeepSeek",
  },
  zai: { hostEnv: ["ZAI_API_KEY", "ZAI_CODE"], sandboxEnv: "ZAI_API_KEY", defaultModel: "glm-5.3", label: "Z.AI" },
  openrouter: {
    hostEnv: ["OPENROUTER_API_KEY"],
    sandboxEnv: "OPENROUTER_API_KEY",
    defaultModel: "xiaomi/mimo-v2.6-flash",
    label: "OpenRouter",
  },
  anthropic: { hostEnv: ["ANTHROPIC_API_KEY"], sandboxEnv: "ANTHROPIC_API_KEY", label: "Anthropic" },
  openai: { hostEnv: ["OPENAI_API_KEY"], sandboxEnv: "OPENAI_API_KEY", label: "OpenAI" },
};

/** A setting by name, in the same order as keys: shell environment, keys file, then .env. */
export function setting(name: string): string | undefined {
  const fromShell = shellEnv[name];
  if (fromShell) return fromShell;
  const saved = readKeysFile()[name];
  if (saved) return saved;
  return process.env[name] || undefined;
}

export function providerKey(provider: string): string | undefined {
  const p = PROVIDERS[provider];
  if (!p) return undefined;
  return keySource(p.hostEnv, shellEnv, process.env, readKeysFile())?.value;
}

/** explicit > DEFAULT_PROVIDER > first provider with a key configured. */
export function resolveProvider(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const configured = setting("DEFAULT_PROVIDER");
  if (configured) return configured;
  return Object.keys(PROVIDERS).find((p) => providerKey(p));
}

function gitProtocol(): "https" | "ssh" {
  const raw = process.env.HIVE_GIT_PROTOCOL || "https";
  if (raw !== "https" && raw !== "ssh") throw new Error(`HIVE_GIT_PROTOCOL must be https or ssh, got "${raw}"`);
  return raw;
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
    "You are a senior software developer. Be direct and concise, show code, skip filler. Don't gold-plate, but don't leave it half-done. Check multiple locations and follow the project's conventions. Flag risks. If unsure, say so. Commit each finished piece of work as soon as it is done, before running long checks, installing tools or starting the next piece: the run has a time limit, and only committed work is kept. If a check needs a tool you can't get working within a few minutes, skip it, say so, and finish.",
  runsDir: resolve(process.env.HIVE_RUNS_DIR || join(cacheHome, "agent-hive/runs")),
  sandbox: {
    runtime: process.env.HIVE_RUNTIME || "auto", // auto | libkrun
    memory: process.env.HIVE_SANDBOX_MEMORY || "1536m",
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
    pushRemote: process.env.HIVE_PUSH_REMOTE || "origin",
    // How the server clones and pushes github.com repos: "https" uses the host's git credential
    // helper (e.g. a `gh` login); "ssh" uses the host's SSH keys (per-repo deploy keys).
    protocol: gitProtocol(),
    // Only for local testing: accept repo URLs other than github.com (file paths, other hosts).
    allowAnyRepoUrl: process.env.HIVE_ALLOW_ANY_REPO_URL === "1",
  },
};

/** The model a provider will use: DEFAULT_MODEL beats the provider's own default. */
export function effectiveModel(provider: string): string | undefined {
  return setting("DEFAULT_MODEL") || PROVIDERS[provider]?.defaultModel || undefined;
}

export interface ProviderInfo {
  default: {
    provider: string | null;
    providerSource: "DEFAULT_PROVIDER" | "first provider with a key" | null;
    model: string | null;
    modelSource: "DEFAULT_MODEL" | "provider default" | null;
    thinking: string;
  };
  providers: { id: string; label: string; hasKey: boolean; model: string | null }[];
}

/** Resolved defaults for the UI/CLI, plus which providers have a key. Never includes key values. */
export function providerInfo(): ProviderInfo {
  const resolved = resolveProvider();
  const provider = resolved !== undefined && PROVIDERS[resolved] ? resolved : null;

  let providerSource: ProviderInfo["default"]["providerSource"] = null;
  if (provider !== null) {
    providerSource =
      setting("DEFAULT_PROVIDER") && setting("DEFAULT_PROVIDER") === provider
        ? "DEFAULT_PROVIDER"
        : "first provider with a key";
  }

  const model = provider !== null ? (effectiveModel(provider) ?? null) : null;
  let modelSource: ProviderInfo["default"]["modelSource"] = null;
  if (model !== null) modelSource = setting("DEFAULT_MODEL") ? "DEFAULT_MODEL" : "provider default";

  return {
    default: {
      provider,
      providerSource,
      model,
      modelSource,
      thinking: config.defaultThinking,
    },
    providers: Object.keys(PROVIDERS).map((id) => ({
      id,
      label: PROVIDERS[id].label,
      hasKey: !!providerKey(id),
      model: effectiveModel(id) ?? null,
    })),
  };
}
