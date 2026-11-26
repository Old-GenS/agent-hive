/**
 * The run settings for Settings > Runs: VM CPUs and memory, runs at once, the time limit, the
 * stall time and the disk limit per run. Reading also says where each value comes from and what
 * this computer can take; saving writes the keys file and applies to new runs without a restart.
 * Every route lives in the authenticated scope in index.ts.
 */
import type { FastifyInstance } from "fastify";
import {
  SETTING_KEYS,
  applySettings,
  environmentMessage,
  host,
  isSettingKey,
  readSettings,
  resetSetting,
  validateSettings,
} from "../settings.js";
import type { SettingKey } from "../settings.js";
import {
  BUILTIN_SYSTEM_PROMPT,
  MAX_SYSTEM_PROMPT,
  defaultSystemPrompt,
  resetSystemPrompt,
  saveSystemPrompt,
} from "../system-prompt.js";

/** Every editable setting, as integers; validateSettings owns the ranges and messages. */
const settingProperties = Object.fromEntries(SETTING_KEYS.map((key) => [key, {}]));

/** A setting this computer's environment sets wins over the file, so it cannot be changed here. */
function environmentKey(patch: Record<string, number | undefined>): SettingKey | undefined {
  const current = readSettings();
  return SETTING_KEYS.find((key) => patch[key] !== undefined && current[key].source === "env");
}

/** The editable default instructions, where they come from, and hive's built-in text. */
function systemPromptBody(): {
  text: string;
  source: "env" | "file" | "builtin";
  builtin: string;
  max: number;
} {
  const current = defaultSystemPrompt();
  return { ...current, builtin: BUILTIN_SYSTEM_PROMPT, max: MAX_SYSTEM_PROMPT };
}

/** HIVE_SYSTEM_PROMPT wins over the file, so the settings page cannot edit it. */
const ENV_PROMPT_MESSAGE = "set by HIVE_SYSTEM_PROMPT in the environment; unset it to edit here";

export default async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => ({ settings: readSettings(), host: host() }));

  app.get("/api/settings/system-prompt", async () => systemPromptBody());

  app.put(
    "/api/settings/system-prompt",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      if (defaultSystemPrompt().source === "env") return reply.code(409).send({ error: ENV_PROMPT_MESSAGE });
      const { text } = req.body as { text: string };
      try {
        saveSystemPrompt(text);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      return systemPromptBody();
    },
  );

  app.delete("/api/settings/system-prompt", async (_req, reply) => {
    if (defaultSystemPrompt().source === "env") return reply.code(409).send({ error: ENV_PROMPT_MESSAGE });
    resetSystemPrompt();
    return systemPromptBody();
  });

  app.put(
    "/api/settings",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: settingProperties,
        },
      },
    },
    async (req, reply) => {
      const patch = (req.body ?? {}) as Record<string, number | undefined>;
      const h = host();
      const result = validateSettings(patch, h);
      if (!result.ok) return reply.code(400).send({ errors: result.errors, warnings: result.warnings });
      const blocked = environmentKey(result.values);
      if (blocked !== undefined) return reply.code(409).send({ error: environmentMessage(blocked) });
      applySettings(result.values);
      return { settings: readSettings(), host: h, warnings: result.warnings };
    },
  );

  app.delete(
    "/api/settings/:key",
    {
      schema: {
        params: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const { key } = req.params as { key: string };
      if (!isSettingKey(key)) return reply.code(404).send({ error: `Unknown setting "${key}"` });
      if (readSettings()[key].source === "env") return reply.code(409).send({ error: environmentMessage(key) });
      resetSetting(key);
      return { settings: readSettings(), host: host() };
    },
  );
}
