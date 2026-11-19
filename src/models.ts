/**
 * Model lists to offer in the UI, per provider. OpenRouter's list is fetched live (and cached for
 * an hour); the others have a short fixed list. The resolved effective model is always offered
 * first, so an empty input in the UI still means "the default".
 */
import { PROVIDERS, effectiveModel } from "./config.js";

export const STATIC_MODELS: Record<string, string[]> = {
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  zai: ["glm-5.3"],
  anthropic: [],
  openai: [],
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_FALLBACK = ["xiaomi/mimo-v2.6-flash"];
const CACHE_TTL_MS = 60 * 60_000;

let openrouterCache: { at: number; models: string[] } | null = null;

/** Empty the OpenRouter cache (tests). */
export function clearModelCache() {
  openrouterCache = null;
}

async function fetchOpenRouter(fetchImpl: typeof fetch): Promise<string[]> {
  if (openrouterCache && Date.now() - openrouterCache.at < CACHE_TTL_MS) return openrouterCache.models;
  try {
    const res = await fetchImpl(OPENROUTER_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    if (!Array.isArray(body?.data)) throw new Error("OpenRouter returned an unexpected body");
    const ids = body.data.map((m) => m?.id).filter((id): id is string => typeof id === "string");
    const models = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    openrouterCache = { at: Date.now(), models };
    return models;
  } catch {
    return [...OPENROUTER_FALLBACK];
  }
}

export async function listModels(provider: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) throw new Error("Unknown provider");
  const base = provider === "openrouter" ? await fetchOpenRouter(fetchImpl) : [...(STATIC_MODELS[provider] ?? [])];
  const effective = effectiveModel(provider);
  if (effective && !base.includes(effective)) base.unshift(effective);
  return base;
}
