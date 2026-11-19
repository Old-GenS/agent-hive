/**
 * Resolved provider/model/thinking defaults for the UI, and the model list to offer per provider.
 * Reports which providers have a key, never the keys themselves.
 */
import type { FastifyInstance } from "fastify";
import { providerInfo } from "../config.js";
import { listModels } from "../models.js";

export default async function providerRoutes(app: FastifyInstance) {
  app.get("/api/providers", async () => providerInfo());

  app.get(
    "/api/models",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", maxLength: 50 } },
        },
      },
    },
    async (req, reply) => {
      const { provider } = req.query as { provider: string };
      try {
        return { provider, models: await listModels(provider) };
      } catch {
        return reply.code(400).send({ error: "Unknown provider" });
      }
    },
  );
}
