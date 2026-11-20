/**
 * Provider API keys for Settings › API keys: list them masked, add one (tested first), test one,
 * make a provider the default and remove a saved key. Every route lives in the authenticated
 * scope in index.ts. A full key is never logged or returned.
 */
import type { FastifyInstance } from "fastify";
import { PROVIDERS, effectiveModel, keysFilePath, providerKey, resolveProvider, shellEnv } from "../config.js";
import { keySource, maskKey, readKeysFile, setKeysFileValue, testKey } from "../keys.js";
import type { KeySource } from "../keys.js";

const KNOWN_PROVIDERS = Object.keys(PROVIDERS);

function environmentMessage(provider: string): string {
  return `${PROVIDERS[provider].hostEnv[0]} is set in the server's environment; change it there`;
}

interface KeyEntry {
  id: string;
  label: string;
  hasKey: boolean;
  source: KeySource | null;
  masked: string | null;
  defaultModel: string | null;
  isDefault: boolean;
  envName: string;
}

export default async function keyRoutes(app: FastifyInstance) {
  app.get("/api/keys", async () => {
    const fileValues = readKeysFile();
    const entries: KeyEntry[] = KNOWN_PROVIDERS.map((id) => {
      const provider = PROVIDERS[id];
      const found = keySource(provider.hostEnv, shellEnv, process.env, fileValues);
      return {
        id,
        label: provider.label,
        hasKey: found !== undefined,
        source: found?.source ?? null,
        masked: found ? maskKey(found.value) : null,
        defaultModel: effectiveModel(id) ?? null,
        isDefault: false,
        envName: provider.hostEnv[0],
      };
    });
    const resolved = resolveProvider();
    const defaultProvider =
      resolved !== undefined && PROVIDERS[resolved] && entries.some((e) => e.id === resolved && e.hasKey)
        ? resolved
        : null;
    for (const entry of entries) entry.isDefault = entry.id === defaultProvider;
    return { file: keysFilePath(), defaultProvider, providers: entries };
  });

  app.post(
    "/api/keys",
    {
      schema: {
        body: {
          type: "object",
          required: ["provider", "key"],
          additionalProperties: false,
          properties: {
            provider: { type: "string", enum: KNOWN_PROVIDERS },
            key: { type: "string", minLength: 8, maxLength: 400 },
          },
        },
      },
    },
    async (req, reply) => {
      const { provider, key } = req.body as { provider: string; key: string };
      const entry = PROVIDERS[provider];
      const current = keySource(entry.hostEnv, shellEnv, process.env, readKeysFile());
      if (current?.source === "environment") {
        return reply.code(409).send({ error: environmentMessage(provider) });
      }
      const result = await testKey(provider, key);
      if (result.status === "refused") return reply.code(400).send({ error: result.detail });
      try {
        setKeysFileValue(entry.hostEnv[0], key);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      return { provider, status: result.status, detail: result.detail, masked: maskKey(key) };
    },
  );

  app.post(
    "/api/keys/:provider/test",
    {
      schema: {
        params: {
          type: "object",
          required: ["provider"],
          additionalProperties: false,
          properties: { provider: { type: "string", enum: KNOWN_PROVIDERS } },
        },
      },
    },
    async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const entry = PROVIDERS[provider];
      const found = keySource(entry.hostEnv, shellEnv, process.env, readKeysFile());
      if (!found) return reply.code(404).send({ error: `No key for ${entry.label}` });
      const result = await testKey(provider, found.value);
      return { provider, status: result.status, detail: result.detail };
    },
  );

  app.delete(
    "/api/keys/:provider",
    {
      schema: {
        params: {
          type: "object",
          required: ["provider"],
          additionalProperties: false,
          properties: { provider: { type: "string", enum: KNOWN_PROVIDERS } },
        },
      },
    },
    async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const entry = PROVIDERS[provider];
      const fileValues = readKeysFile();
      const found = keySource(entry.hostEnv, shellEnv, process.env, fileValues);
      if (found?.source === "environment") {
        return reply.code(409).send({ error: environmentMessage(provider) });
      }
      if (!entry.hostEnv.some((name) => fileValues[name])) {
        return reply.code(404).send({ error: `No saved key for ${entry.label}` });
      }
      for (const name of entry.hostEnv) setKeysFileValue(name, null);
      if (fileValues.DEFAULT_PROVIDER === provider) setKeysFileValue("DEFAULT_PROVIDER", null);
      return { provider, removed: true };
    },
  );

  app.put(
    "/api/keys/default",
    {
      schema: {
        body: {
          type: "object",
          required: ["provider"],
          additionalProperties: false,
          properties: { provider: { type: "string", enum: KNOWN_PROVIDERS } },
        },
      },
    },
    async (req, reply) => {
      const { provider } = req.body as { provider: string };
      if (shellEnv.DEFAULT_PROVIDER) {
        return reply.code(409).send({
          error: "DEFAULT_PROVIDER is set in the server's environment; change it there",
        });
      }
      if (!providerKey(provider)) {
        return reply.code(400).send({ error: `No key for ${PROVIDERS[provider].label}` });
      }
      setKeysFileValue("DEFAULT_PROVIDER", provider);
      return { defaultProvider: provider };
    },
  );
}
