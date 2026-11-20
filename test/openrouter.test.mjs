// OpenRouter setup: pi's models.json for a model, provider ranking from the endpoint list, and the
// two API reads behind a fake fetch. No real request is made.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed before any dist/ import: config.ts reads them at import time.
const root = mkdtempSync(join(tmpdir(), "hive-openrouter-"));
process.env.HIVE_RUNS_DIR = root;
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
process.env.HIVE_KEYS_FILE = join(root, "missing-keys");

const { modelsJson, openrouterSetup, rankEndpoints } = await import("../dist/openrouter.js");

const MODEL = {
  id: "acme/model-a",
  name: "Acme Model A",
  supported_parameters: ["tools", "reasoning"],
  architecture: { input_modalities: ["text", "image"] },
  context_length: 200_000,
  top_provider: { max_completion_tokens: 64_000 },
  pricing: {
    prompt: "0.0000004",
    completion: "0.0000008",
    input_cache_read: "0.0000001",
    input_cache_write: "0.0000002",
  },
};

/** An endpoint that passes every filter, with optional overrides. */
function endpoint(tag, overrides = {}) {
  return {
    tag,
    status: 0,
    uptime_last_1d: 0,
    quantization: "fp16",
    supported_parameters: ["tools"],
    pricing: { prompt: "0.000001", input_cache_read: "0.0000001" },
    ...overrides,
  };
}

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test("modelsJson builds pi's models.json for an OpenRouter model", () => {
  const json = modelsJson(MODEL, {});
  const model = json.providers.openrouter.models[0];
  assert.equal(model.id, "acme/model-a");
  assert.equal(model.name, "Acme Model A");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 64_000);
  // Prices come per token and models.json wants per million.
  for (const [key, expected] of Object.entries({ input: 0.4, output: 0.8, cacheRead: 0.1, cacheWrite: 0.2 })) {
    assert.ok(Math.abs(model.cost[key] - expected) < 1e-12, `cost.${key} is ${model.cost[key]}`);
  }
  // Empty routing means no compat block.
  assert.deepEqual(model.compat, {});

  const routed = modelsJson(MODEL, { quantizations: ["fp16"] });
  assert.deepEqual(routed.providers.openrouter.models[0].compat, {
    openRouterRouting: { quantizations: ["fp16"] },
  });

  const plain = modelsJson(
    { ...MODEL, supported_parameters: [], architecture: { input_modalities: ["text"] } },
    {},
  ).providers.openrouter.models[0];
  assert.equal(plain.reasoning, false);
  assert.deepEqual(plain.input, ["text"]);
});

test("rankEndpoints puts the maker first, then higher uptime, then lower price", () => {
  const endpoints = [
    endpoint("other/low", { uptime_last_1d: 10, pricing: { prompt: "0.000001", input_cache_read: "0.0000001" } }),
    endpoint("acme/own", { uptime_last_1d: 0, pricing: { prompt: "0.000009", input_cache_read: "0.0000001" } }),
    endpoint("other/high", { uptime_last_1d: 99, pricing: { prompt: "0.000005", input_cache_read: "0.0000001" } }),
    endpoint("other/high-cheap", { uptime_last_1d: 99, pricing: { prompt: "0.0000005", input_cache_read: "0.0000001" } }),
  ];
  const { routing, note } = rankEndpoints(endpoints, { quantizations: ["fp16"] }, "acme/model-a");
  assert.deepEqual(routing.order, ["acme/own", "other/high-cheap", "other/high", "other/low"]);
  assert.equal(routing.allow_fallbacks, true);
  assert.deepEqual(routing.quantizations, ["fp16"]);
  assert.equal(note, undefined);
});

test("rankEndpoints drops down, tool-less, cache-priceless and disallowed-quantization endpoints", () => {
  const endpoints = [
    endpoint("good"),
    endpoint("down", { status: 1 }),
    endpoint("no-tools", { supported_parameters: ["reasoning"] }),
    endpoint("no-cache", { pricing: { prompt: "0.000001", input_cache_read: null } }),
    endpoint("fp4", { quantization: "fp4" }),
  ];
  const { routing } = rankEndpoints(endpoints, { quantizations: ["fp16", "bf16", "fp8"] }, "acme/model-a");
  assert.deepEqual(routing.order, ["good"]);
});

test("rankEndpoints drops the quantization filter when no endpoint supports it", () => {
  const endpoints = [
    endpoint("a", { quantization: "fp4" }),
    endpoint("b", { quantization: "fp4", uptime_last_1d: 5 }),
  ];
  const { routing, note } = rankEndpoints(endpoints, { quantizations: ["fp16"] }, "acme/model-a");
  assert.equal(note, "no endpoint of acme/model-a is fp16; allowing any for this run");
  assert.equal(routing.quantizations, undefined);
  assert.deepEqual(routing.order, ["b", "a"]);
  assert.equal(routing.allow_fallbacks, true);
});

test("rankEndpoints leaves an explicit order or only routing unchanged", () => {
  const order = { order: ["some/tag"], allow_fallbacks: false };
  assert.equal(rankEndpoints([endpoint("a")], order, "acme/model-a").routing, order);

  const only = { only: ["some/provider"] };
  assert.equal(rankEndpoints([endpoint("a")], only, "acme/model-a").routing, only);
});

test("openrouterSetup lists the model, ranks the endpoints and builds models.json", async () => {
  const endpoints = [
    endpoint("acme/own"),
    endpoint("other/x", { uptime_last_1d: 50, pricing: { prompt: "0.000002", input_cache_read: "0.0000001" } }),
  ];
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/models")) return response({ data: [MODEL] });
    if (String(url).endsWith("/endpoints")) return response({ data: { endpoints } });
    throw new Error("unexpected URL " + url);
  };

  const setup = await openrouterSetup("acme/model-a", { quantizations: ["fp16"] }, fetchImpl);
  assert.equal(setup.modelsJson.providers.openrouter.models[0].id, "acme/model-a");
  assert.deepEqual(setup.routing.order, ["acme/own", "other/x"]);
  assert.equal(setup.routing.allow_fallbacks, true);
  assert.equal(setup.note, undefined);
});

test("openrouterSetup throws a clear error for an unknown model", async () => {
  const fetchImpl = async () => response({ data: [MODEL] });
  await assert.rejects(
    openrouterSetup("nope/x", {}, fetchImpl),
    /model 'nope\/x' not found on OpenRouter \(see https:\/\/openrouter\.ai\/models\)/,
  );
});

test("openrouterSetup keeps the routing and notes when the endpoint list fails", async () => {
  const fetchImpl = async (url) =>
    String(url).endsWith("/models") ? response({ data: [MODEL] }) : response({}, false, 500);
  const routing = { quantizations: ["fp16"] };
  const setup = await openrouterSetup("acme/model-a", routing, fetchImpl);
  assert.deepEqual(setup.routing, routing);
  assert.equal(setup.note, "couldn't list providers for acme/model-a; letting OpenRouter choose");
});
