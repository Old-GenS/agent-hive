/**
 * GitHub helpers for the UI, via the host's `gh` login: list your repos and branches.
 * Cloning and pushing happen per task (see git.ts), not here.
 */
import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cancelGithubLogin, githubLoginState, startGithubLogin } from "../github-login.js";

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

/** `POST /api/github/login`: no body, or `{ "refresh": true }` to add the workflow scope. */
const loginSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      refresh: { type: "boolean" },
    },
  },
} as const;

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

  // Branches of a repo, for the UI's branch list: the default branch first, then the rest by name.
  app.get("/api/github/branches", {
    schema: {
      querystring: {
        type: "object",
        required: ["repo"],
        properties: { repo: { type: "string", pattern: OWNER_REPO.source, maxLength: 200 } },
      },
    },
  }, async (req, reply) => {
    const { repo } = req.query as { repo: string };
    // "." / ".." parts would turn repos/<repo> into another GitHub API path.
    if (repo.split("/").some((part) => part === "." || part === "..")) {
      return reply.code(400).send({ error: "Invalid repo" });
    }
    try {
      const [{ stdout: def }, { stdout: list }] = await Promise.all([
        gh(["api", `repos/${repo}`, "--jq", ".default_branch"]),
        gh(["api", "--paginate", `repos/${repo}/branches?per_page=100`, "--jq", ".[].name"]),
      ]);
      const defaultBranch = def.trim();
      const names = [...new Set(list.split("\n").map((b) => b.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const branches = defaultBranch ? [defaultBranch, ...names.filter((b) => b !== defaultBranch)] : names;
      return { repo, defaultBranch, branches };
    } catch (err: any) {
      return reply.code(502).send({ error: "Couldn't list branches (does the repo exist, and can gh see it?)" });
    }
  });

  // GitHub's device login, started from the web UI's Connect GitHub button (the person enters the
  // code on their own device). Works the same with HIVE_GIT_PROTOCOL=ssh: it logs the server's own
  // `gh` in, which the bot-account setup uses for repos, pull requests and new repositories.
  // `{ "refresh": true }` runs `gh auth refresh` instead, to add the workflow scope to the login.
  app.post(
    "/api/github/login",
    {
      schema: loginSchema,
      // The body is optional: an old client's POST without one means "log in", not a bad request.
      preValidation: async (req) => {
        if (req.body === undefined) req.body = {};
      },
    },
    async (req) => {
      const body = (req.body ?? {}) as { refresh?: boolean };
      return startGithubLogin({ refresh: body.refresh === true });
    },
  );
  app.get("/api/github/login", async () => githubLoginState());
  app.delete("/api/github/login", async () => {
    cancelGithubLogin();
    return { state: "idle" };
  });

  app.get("/api/user", async (req) => req.hiveUser);
}
