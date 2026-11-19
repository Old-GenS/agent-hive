/**
 * Resolved provider/model/thinking defaults for the UI. Reports which providers have a key,
 * never the keys themselves.
 */
import type { FastifyInstance } from "fastify";
import { providerInfo } from "../config.js";

export default async function providerRoutes(app: FastifyInstance) {
  app.get("/api/providers", async () => providerInfo());
}
