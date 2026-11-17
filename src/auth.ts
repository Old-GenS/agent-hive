import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface HiveUser {
  name: string;
  role: string;
}

const users: { digest: Buffer; user: HiveUser }[] = [];
const sha = (s: string) => createHash("sha256").update(s).digest();

export function loadTokens(): number {
  if (process.env.API_TOKENS) {
    let parsed: Record<string, { name?: string; role?: string }>;
    try {
      parsed = JSON.parse(process.env.API_TOKENS);
    } catch {
      throw new Error("API_TOKENS is not valid JSON");
    }
    for (const [token, profile] of Object.entries(parsed)) addToken(token, { name: profile.name || "User", role: profile.role || "user" });
  }
  if (process.env.API_TOKEN) addToken(process.env.API_TOKEN, { name: "Admin", role: "admin" });
  return users.length;
}

function addToken(token: string, user: HiveUser) {
  if (token.length < 16) throw new Error(`API token for ${user.name} is too short (min 16 chars; use: openssl rand -hex 32)`);
  users.push({ digest: sha(token), user });
}

/** Constant-time lookup: compares SHA-256 digests so length and content don't leak via timing. */
export function findUser(token: string | undefined): HiveUser | undefined {
  if (!token) return undefined;
  const d = sha(token);
  let found: HiveUser | undefined;
  for (const u of users) if (timingSafeEqual(u.digest, d)) found = u.user;
  return found;
}

// One-time WebSocket tickets, so the API token never appears in a URL (or in access logs).
const tickets = new Map<string, { user: HiveUser; sessionId: string; expires: number }>();

export function issueTicket(user: HiveUser, sessionId: string): string {
  const now = Date.now();
  for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t);
  const ticket = randomBytes(24).toString("hex");
  tickets.set(ticket, { user, sessionId, expires: now + 60_000 });
  return ticket;
}

export function redeemTicket(ticket: string | undefined, sessionId: string): HiveUser | undefined {
  if (!ticket) return undefined;
  const t = tickets.get(ticket);
  tickets.delete(ticket);
  if (!t || t.expires < Date.now() || t.sessionId !== sessionId) return undefined;
  return t.user;
}

declare module "fastify" {
  interface FastifyRequest {
    hiveUser?: HiveUser;
  }
}

/** onRequest hook for the API scope: Bearer token, or a WebSocket ticket on /events/:id. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  let user = findUser(bearer);
  if (!user && req.routeOptions.url === "/events/:sessionId") {
    const { ticket } = (req.query || {}) as { ticket?: string };
    const { sessionId } = (req.params || {}) as { sessionId?: string };
    user = redeemTicket(ticket, sessionId || "");
  }
  if (!user) return reply.code(401).send({ error: "Unauthorized" });
  req.hiveUser = user;
}
