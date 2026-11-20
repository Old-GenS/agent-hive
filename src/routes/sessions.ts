import type { FastifyInstance } from "fastify";
import { issueTicket } from "../auth.js";
import { BusyError, capacity, createTask, destroyTask, getTask, listTasks, openTaskIssue, openTaskPr, runPrompt, type Task } from "../tasks.js";

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
      newRepo: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          private: { type: "boolean" },
        },
      },
    },
  },
} as const;

function taskOr404(id: string, reply: any): Task | undefined {
  const task = getTask(id);
  if (!task) reply.code(404).send({ error: "Session not found" });
  return task;
}

export default async function sessionRoutes(app: FastifyInstance) {
  app.post("/prompt", { schema: promptSchema }, async (req, reply) => {
    const body = req.body as any;

    if (body.sessionId) {
      const task = taskOr404(body.sessionId, reply);
      if (!task) return;
      if (task.busy) return reply.code(409).send({ error: `Session is ${task.status}; wait for it to finish or abort it` });
      void runPrompt(task, body.prompt);
      return { sessionId: task.id, status: task.status, repo: task.repoUrl, stepStartedAt: task.stepStartedAt, finishedAt: task.finishedAt };
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
        newRepo: body.newRepo,
      });
    } catch (err) {
      return reply.code(err instanceof BusyError ? 503 : 400).send({ error: (err as Error).message });
    }
    void runPrompt(task, body.prompt);
    return {
      sessionId: task.id,
      status: task.status,
      repo: task.repoUrl,
      newRepo: task.newRepoName,
      model: task.model,
      provider: task.provider,
      stepStartedAt: task.stepStartedAt,
      finishedAt: task.finishedAt,
    };
  });

  app.get("/runs", async () => ({ runs: listTasks(), capacity: capacity() }));

  app.get("/status/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    return task && task.toJSON();
  });

  // Post a no-change review to a GitHub issue (only when the user clicks).
  app.post("/issue/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    if (!task) return;
    try {
      return { sessionId: task.id, url: await openTaskIssue(task) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Open a pull request from the run's branch (only when the user clicks; never automatic).
  app.post("/pr/:sessionId", async (req, reply) => {
    const task = taskOr404((req.params as any).sessionId, reply);
    if (!task) return;
    try {
      return { sessionId: task.id, url: await openTaskPr(task) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
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
