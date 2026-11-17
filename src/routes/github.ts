/**
 * GitHub helpers for the UI, via the host's `gh` login: list your repos, search, fork.
 * Cloning and pushing happen per task (see git.ts), not here.
 */
import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GH_BIN = process.env.GH_BIN || "gh";
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function gh(args: string[]) {
  return execFileAsync(GH_BIN, args, {
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export default async function githubRoutes(app: FastifyInstance) {
  app.get("/api/github/repos", async (_req, reply) => {
    try {
      const { stdout } = await gh(["repo", "list", "--limit", "100", "--json", "name,nameWithOwner,owner,description,url,visibility,isArchived"]);
      return JSON.parse(stdout);
    } catch (err: any) {
      app.log.error({ err: err.message }, "gh repo list failed");
      return reply.code(502).send({ error: "Couldn't list repos (is gh logged in on the server?)" });
    }
  });

  app.get("/api/github/search", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", minLength: 1, maxLength: 200 },
          sort: { type: "string", enum: ["stars", "forks", "updated", "help-wanted-issues"] },
          order: { type: "string", enum: ["asc", "desc"] },
          per_page: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  }, async (req, reply) => {
    const { q, sort, order, per_page } = req.query as { q: string; sort?: string; order?: string; per_page: number };
    const args = ["search", "repos", "--limit", String(per_page), "--json",
      "fullName,name,owner,description,url,visibility,stargazersCount,language"];
    if (sort) args.push("--sort", sort);
    if (order) args.push("--order", order);
    args.push("--", q);
    try {
      const { stdout } = await gh(args);
      return JSON.parse(stdout);
    } catch (err: any) {
      return reply.code(502).send({ error: "Search failed" });
    }
  });

  // Fork into the account gh is logged in as; returns owner/name to use as a task's repo.
  app.post("/api/github/fork", {
    schema: { body: { type: "object", required: ["repo"], properties: { repo: { type: "string", pattern: OWNER_REPO.source } } } },
  }, async (req, reply) => {
    const { repo } = req.body as { repo: string };
    try {
      await gh(["repo", "fork", repo, "--clone=false", "--remote=false"]);
      const { stdout: login } = await gh(["api", "user", "--jq", ".login"]);
      return { forked: true, repo: `${login.trim()}/${repo.split("/")[1]}` };
    } catch (err: any) {
      return reply.code(502).send({ error: `Fork failed: ${err.stderr?.trim() || err.message}` });
    }
  });

  app.get("/api/user", async (req) => req.hiveUser);
}
