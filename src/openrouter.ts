/**
 * OpenRouter setup for a run: pi's models.json for the chosen model, and provider routing chosen
 * from OpenRouter's endpoint list (the logic ported from pi-vm).
 *
 * The only network calls are the two OpenRouter API reads in openrouterSetup(); tests pass a fake
 * fetch and never reach the network.
 */
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 20_000;

/** Pricing is per token; models.json wants per million tokens. */
function perMillion(price: unknown): number {
  return Number(price ?? "0") * 1_000_000;
}

/**
 * pi's models.json for one OpenRouter model `m` (an entry of GET /api/v1/models), with the given
 * provider `routing` attached as `compat.openRouterRouting` unless it is empty.
 */
export function modelsJson(m: any, routing: object): any {
  const empty = Object.keys(routing).length === 0;
  return {
    providers: {
      openrouter: {
        models: [
          {
            id: m.id,
            name: m.name,
            reasoning: (m.supported_parameters ?? []).includes("reasoning"),
            input: (m.architecture?.input_modalities ?? []).includes("image") ? ["text", "image"] : ["text"],
            contextWindow: m.context_length,
            maxTokens: m.top_provider?.max_completion_tokens ?? 32000,
            cost: {
              input: perMillion(m.pricing?.prompt),
              output: perMillion(m.pricing?.completion),
              cacheRead: perMillion(m.pricing?.input_cache_read),
              cacheWrite: perMillion(m.pricing?.input_cache_write),
            },
            compat: empty ? {} : { openRouterRouting: routing },
          },
        ],
      },
    },
  };
}

/**
 * Choose the provider endpoints to use for `model`, from OpenRouter's endpoint list. A routing
 * with an explicit `order` or `only` is left alone. Otherwise: drop endpoints that are down, lack
 * tool support or cache pricing, or use a quantization the routing forbids; put the model maker's
 * own endpoint first, then higher 1-day uptime, then lower price, and pass the tags as `order`
 * with fallbacks allowed. If nothing usable is left the routing is returned as is.
 */
export function rankEndpoints(
  endpoints: any[],
  routing: any,
  model: string,
): { routing: any; note?: string } {
  if (routing !== null && typeof routing === "object" && (routing.order !== undefined || routing.only !== undefined)) {
    return { routing };
  }

  let effective: any = routing !== null && typeof routing === "object" ? routing : {};
  let note: string | undefined;
  const up = (Array.isArray(endpoints) ? endpoints : []).filter((endpoint) => (endpoint?.status ?? 0) === 0);

  // No endpoint supports the allowed quantizations: allow any for this run, with a note.
  const wanted: unknown[] = Array.isArray(effective.quantizations) ? effective.quantizations : [];
  if (wanted.length > 0 && up.length > 0 && !up.some((endpoint) => wanted.includes(endpoint?.quantization))) {
    effective = { ...effective };
    delete effective.quantizations;
    note = `no endpoint of ${model} is ${wanted.join("/")}; allowing any for this run`;
  }

  const allowed = Array.isArray(effective.quantizations) ? (effective.quantizations as unknown[]) : undefined;
  const usable = up.filter(
    (endpoint) =>
      (allowed === undefined || allowed.includes(endpoint?.quantization)) &&
      Array.isArray(endpoint?.supported_parameters) &&
      endpoint.supported_parameters.includes("tools") &&
      endpoint?.pricing?.input_cache_read !== null &&
      endpoint?.pricing?.input_cache_read !== undefined,
  );
  if (usable.length === 0) return note === undefined ? { routing: effective } : { routing: effective, note };

  const maker = model.split("/")[0].toLowerCase();
  const isMaker = (endpoint: any) =>
    String(endpoint?.tag ?? "").split("/")[0].toLowerCase() === maker;
  usable.sort((a, b) => {
    const byMaker = Number(isMaker(b)) - Number(isMaker(a));
    if (byMaker !== 0) return byMaker;
    const byUptime = Math.floor(b?.uptime_last_1d ?? 0) - Math.floor(a?.uptime_last_1d ?? 0);
    if (byUptime !== 0) return byUptime;
    return Number(a?.pricing?.prompt ?? 0) - Number(b?.pricing?.prompt ?? 0);
  });
  const tags = usable.map((endpoint) => endpoint.tag).filter((tag) => tag !== undefined);
  const result = { ...effective, order: tags, allow_fallbacks: true };
  return note === undefined ? { routing: result } : { routing: result, note };
}

/**
 * Look `model` up on OpenRouter, choose its provider routing, and build the models.json for it.
 * Throws when the model isn't listed; when provider listing fails the routing is used unchanged
 * and a note explains that OpenRouter will choose.
 */
export async function openrouterSetup(
  model: string,
  routing: any,
  fetchImpl: typeof fetch = fetch,
): Promise<{ modelsJson: any; routing: any; note?: string }> {
  const listRes = await fetchImpl(MODELS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!listRes.ok) throw new Error(`OpenRouter model list failed: HTTP ${listRes.status}`);
  const list: any = await listRes.json();
  const entry = (Array.isArray(list?.data) ? list.data : []).find((candidate: any) => candidate?.id === model);
  if (entry === undefined) {
    throw new Error(`model '${model}' not found on OpenRouter (see https://openrouter.ai/models)`);
  }

  let finalRouting = routing;
  let note: string | undefined;
  try {
    const res = await fetchImpl(`${MODELS_URL}/${model}/endpoints`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload: any = await res.json();
    // The API wraps the result: { data: { id, endpoints: [...] } }.
    const data = payload?.data ?? payload;
    const ranked = rankEndpoints(Array.isArray(data?.endpoints) ? data.endpoints : [], routing, model);
    finalRouting = ranked.routing;
    note = ranked.note;
  } catch {
    note = `couldn't list providers for ${model}; letting OpenRouter choose`;
  }

  const result = { modelsJson: modelsJson(entry, finalRouting), routing: finalRouting } as {
    modelsJson: any;
    routing: any;
    note?: string;
  };
  if (note !== undefined) result.note = note;
  return result;
}
