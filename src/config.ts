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

function int(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be ${min === 0 ? "a non-negative" : "a positive"} integer, got "${raw}"`);
  return n;
}

/** HIVE_OPENROUTER_ROUTING: a JSON object of OpenRouter provider routing, or the default. */
const DEFAULT_OPENROUTER_ROUTING = { quantizations: ["fp16", "bf16", "fp8"] };

function openrouterRouting(): object {
  const raw = process.env.HIVE_OPENROUTER_ROUTING;
  if (!raw) return DEFAULT_OPENROUTER_ROUTING;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`HIVE_OPENROUTER_ROUTING must be valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`HIVE_OPENROUTER_ROUTING must be a JSON object, got ${JSON.stringify(parsed)}`);
  }
  return parsed as object;
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

/**
 * The VM's network. "proxy" (the default) gives the VM only hive's egress proxy, which refuses
 * this computer and the local network; "direct" is the old behaviour (pasta's own network:
 * internet and local network, not this computer).
 */
function networkMode(): "proxy" | "direct" {
  const raw = process.env.HIVE_NETWORK || "proxy";
  if (raw !== "proxy" && raw !== "direct") throw new Error(`HIVE_NETWORK must be proxy or direct, got "${raw}"`);
  return raw;
}

function gitProtocol(): "https" | "ssh" {
  const raw = process.env.HIVE_GIT_PROTOCOL || "https";
  if (raw !== "https" && raw !== "ssh") throw new Error(`HIVE_GIT_PROTOCOL must be https or ssh, got "${raw}"`);
  return raw;
}

export const config = {
  port: int("PORT", 8080),
  host: process.env.HOST || "127.0.0.1",
  maxConcurrent: int("MAX_CONCURRENT_SESSIONS", 2),
  defaultModel: process.env.DEFAULT_MODEL || "",
  defaultThinking: process.env.DEFAULT_THINKING || "low",
  systemPrompt:
    process.env.HIVE_SYSTEM_PROMPT ||
    "You are a senior software developer. Be direct and concise, show code, skip filler. Don't gold-plate, but don't leave it half-done. Check multiple locations and follow the project's conventions. Flag risks. If unsure, say so. Commit each finished piece of work as soon as it is done, before running long checks, installing tools or starting the next piece: the run has a time limit, and only committed work is kept. If a check needs a tool you can't get working within a few minutes, skip it, say so, and finish.",
  runsDir: resolve(process.env.HIVE_RUNS_DIR || join(cacheHome, "agent-hive/runs")),
  /** Finished runs older than this many days are deleted; 0 keeps them forever. */
  runRetentionDays: int("HIVE_RUN_RETENTION_DAYS", 14, 0),
  /** Per-repo VM cache buckets not used for this many days are deleted; 0 keeps them. */
  vmCacheDays: int("HIVE_VM_CACHE_DAYS", 30, 0),
  /** OpenRouter provider routing, parsed from HIVE_OPENROUTER_ROUTING (invalid JSON throws when used). */
  get openrouterRouting(): object {
    return openrouterRouting();
  },
  sandbox: {
    runtime: process.env.HIVE_RUNTIME || "auto", // auto | libkrun
    // proxy (default) = the VM reaches only hive's egress proxy, which refuses this computer and
    // the local network; direct = the old behaviour (pasta's own network: internet and LAN, not
    // this computer).
    network: networkMode(),
    memory: process.env.HIVE_SANDBOX_MEMORY || "2048m",
    cpus: process.env.HIVE_SANDBOX_CPUS || "1",
    timeoutMin: int("HIVE_SANDBOX_TIMEOUT_MIN", 60),
    // Stop a run when no file in its work/ folder changed and no agent event arrived for this many
    // minutes. 0 turns it off.
    stallMin: int("HIVE_STALL_MIN", 15),
    vmBin: process.env.HIVE_VM_BIN || resolve(repoRoot, "vm/hive-vm"),
    rootfs: process.env.HIVE_ROOTFS || join(dataHome, "agent-hive/rootfs/current"),
    // The value of HIVE_LIBKRUN, if the user forced one. The effective library is picked by
    // libkrunChoice() in src/libkrun.ts (custom, then a working system libkrun, then the bundled
    // one).
    libkrun: process.env.HIVE_LIBKRUN || "",
    // ~/.cache for the agent (Playwright browsers, npm, pip, corepack...), kept between runs. The
    // folder holds one bucket per repo under repos/, so only runs of the same repo share it.
    // HIVE_VM_CACHE="" disables it.
    vmCache: process.env.HIVE_VM_CACHE ?? join(cacheHome, "agent-hive/vm-cache"),
    // Stop an agent step when the run folder plus its cache bucket uses more than this many GB;
    // 0 turns it off.
    diskMaxGb: int("HIVE_RUN_DISK_MAX_GB", 20, 0),
    // Stop an agent step when less than this many GB are free on the disk holding the runs;
    // 0 turns it off.
    minFreeGb: int("HIVE_MIN_FREE_DISK_GB", 2, 0),
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
