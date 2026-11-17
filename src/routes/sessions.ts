import type { FastifyInstance } from "fastify";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { issueTicket } from "../auth.js";
import { BusyError, createTask, destroyTask, getTask, runPrompt, type Task } from "../tasks.js";

const promptSchema = {
  body: {
    type: "object",
    required: ["prompt"],
    additionalProperties: false,
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 200_000 },
      sessionId: { type: "string" },
      repo: { type: "string", maxLength: 300 },
      branch: { type: "string", maxLength: 200 },
      provider: { type: "string", maxLength: 50 },
      model: { type: "string", maxLength: 200 },
      thinkingLevel: { type: "string" },
      systemPromptOverride: { type: "string", maxLength: 20_000 },
      reviewCycles: { type: "integer", minimum: 0, maximum: 5 },
      reviewModel: { type: "string", maxLength: 200 },
    },
  },
} as const;

function taskOr404(id: string, reply: any): Task | undefined {
  const task = getTask(id);
  if (!task) reply.code(404).send({ error: "Session not found" });
  return task;
}

/** Resolve a path inside a task's work dir, refusing anything (including symlinks) that leaves it. */
function insideWork(task: Task, sub: string): string {
  const root = realpathSync(join(task.dir, "work"));
  const target = realpathSync(join(root, sub || "."));
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path outside the workspace");
  return target;
}

export default async function sessionRoutes(app: FastifyInstance) {
  app.post("/prompt", { schema: promptSchema }, async (req, reply) => {
    const body = req.body as any;

    if (body.sessionId) {
      const task = taskOr404(body.sessionId, reply);
      if (!task) return;
      if (task.busy) return reply.code(409).send({ error: `Session is ${task.status}; wait for it to finish or abort it` });
      void runPrompt(task, body.prompt);
      return { sessionId: task.id, status: task.status, repo: task.repoUrl };
    }

    let task: Task;
    try {
      task = createTask({
        prompt: body.prompt,
        repo: body.repo,
        branch: body.branch,
        provider: body.provider,
        model: body.model,
        thinkingLevel: body.thinkingLevel,
        systemPrompt: body.systemPromptOverride,
        reviewCycles: body.reviewCycles,
        reviewModel: body.reviewModel,
      });
    } catch (err) {
      return reply.code(err instanceof BusyError ? 503 : 400).send({ error: (err as Error).message });
    }
    void runPrompt(task, body.prompt);
    return { sessionId: task.id, status: task.status, repo: task.repoUrl, model: task.model, provider: task.provider };
  });

  app.post("/snippet", {
    schema: {
      body: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 200_000 },
          code: { type: "string", maxLength: 500_000 },
          language: { type: "string", maxLength: 50 },
          provider: { type: "string", maxLength: 50 },
          model: { type: "string", maxLength: 200 },
          thinkingLevel: { type: "string" },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as any;
    const prompt = body.code
      ? `${body.prompt}\n\nCode:\n\`\`\`${body.language || ""}\n${body.code}\n\`\`\``
      : body.prompt;
    let task: Task;
    try {
      task = createTask({ prompt, provider: body.provider, model: body.model, thinkingLevel: body.thinkingLevel, ephemeral: true });
    } catch (err) {
      return reply.code(err instanceof BusyError ? 503 : 400).send({ error: (err as Error).message });
    }
    // A client that hangs up mid-request shouldn't leave a sandbox running.
    // (reply.raw, not req.raw: the request emits "close" as soon as its body has been read.)
    const onClose = () => { if (!reply.raw.writableFinished && task.busy) destroyTask(task.id); };
    reply.raw.on("close", onClose);
    try {
      await runPrompt(task, prompt);
      if (task.status !== "idle") return reply.code(502).send({ error: task.error || task.status });
      return { result: task.lastAssistantText };
    } finally {
      reply.raw.off("close", onClose);
      destroyTask(task.id);
    }
  });

  app.get("/status/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    return task && task.toJSON();
  });

  app.get("/messages/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    return task && { sessionId: task.id, messages: task.messages };
  });

  app.post("/abort/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    if (!task) return;
    await task.abort();
    return { sessionId: task.id, status: "aborted" };
  });

  app.delete("/session/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    if (!task) return;
    destroyTask(task.id);
    return { sessionId: task.id, status: "destroyed" };
  });

  // Browse the agent's working copy (read-only).
  app.get("/files/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    if (!task) return;
    const { path = "" } = req.query as { path?: string };
    try {
      const dir = insideWork(task, path);
      const files = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name !== ".git")
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file",
          size: e.isFile() ? lstatSync(join(dir, e.name)).size : 0,
        }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return { path, files };
    } catch {
      return reply.code(404).send({ error: "Directory not found" });
    }
  });

  app.get("/file/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    if (!task) return;
    const { path } = req.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path is required" });
    try {
      const file = insideWork(task, path);
      const st = lstatSync(file);
      if (!st.isFile()) throw new Error("not a file");
      const MAX = 200_000;
      const content = readFileSync(file).subarray(0, MAX).toString("utf8");
      return { content, truncated: st.size > MAX, totalSize: st.size };
    } catch {
      return reply.code(404).send({ error: "File not found" });
    }
  });

  // One-time ticket for opening /events/:sessionId from a browser (which can't send headers).
  app.post("/events/:sessionId/ticket", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    if (!task) return;
    return { ticket: issueTicket(req.hiveUser!, task.id) };
  });

  app.get("/events/:sessionId", { websocket: true }, (socket, req) => {
    const task = getTask((req.params as any).sessionId);
    if (!task) {
      socket.close(4004, "Session not found");
      return;
    }
    const send = (event: any) => {
      if (socket.readyState === 1) {
        try {
          socket.send(JSON.stringify(event));
        } catch {}
      }
    };
    for (const event of task.replay) send(event);
    task.on("event", send);
    socket.on("close", () => task.off("event", send));
  });
}
