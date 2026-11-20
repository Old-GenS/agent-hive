/**
 * The web UI's run API, backed by the CLI run engine (`src/runs.ts`). A run is a folder under
 * `config.runsDir`; its id is the folder name. Runs started by this process live in an in-memory
 * registry, so a live run can be aborted and its events replayed to WebSocket clients; finished
 * runs are read back from meta.json and io/events.jsonl.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { issueTicket } from "./auth.js";
import { config } from "./config.js";
import { changeSummary, githubSlug, issueBody, normalizeRepo, openIssue, type ChangeSummary } from "./git.js";
import { runtimeInfo } from "./sandbox.js";
import { cleanRun, listRuns, openPr, pushRun, readMeta, startRun, writeMeta, type RunMeta } from "./runs.js";

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

/** A run started by this process, so its events are still in memory. */
interface LiveRun {
  abort: AbortController;
  replay: any[];
  listeners: Set<(event: any) => void>;
}

const liveRuns = new Map<string, LiveRun>();
const changesById = new Map<string, ChangeSummary>();

/** Add an event to a live run's replay buffer and hand it to every listener. */
function publish(id: string, event: any): void {
  const run = liveRuns.get(id);
  if (!run) return;
  run.replay.push(event);
  for (const listener of run.listeners) listener(event);
}

/** How many runs this process is running right now. */
export function liveCount(): number {
  return liveRuns.size;
}

/** The UI's status for a run folder: live runs are running, otherwise it follows meta.json. */
export function uiStatus(meta: RunMeta, live: boolean): "running" | "idle" | "failed" | "aborted" {
  if (live) return "running";
  if (meta.status === "done") return "idle";
  if (meta.status === "failed") return "failed";
  if (meta.status === "aborted") return "aborted";
  // A run still marked "running" whose process is gone (server/CLI restarted) never finished.
  return "failed";
}

/** A one-line title for the run list: the prompt's first non-empty line, at most 80 characters. */
function runTitle(meta: RunMeta): string {
  const line = meta.prompt.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

/** One run in the shapes the web UI reads (the old `Task.toJSON()`, backed by meta.json). */
export function runToJSON(id: string, meta: RunMeta, live: boolean, changes?: ChangeSummary) {
  return {
    sessionId: id,
    title: runTitle(meta),
    status: uiStatus(meta, live),
    isStreaming: live,
    repo: meta.repo,
    resultBranch: meta.pushed?.branch,
    commitsPushed: meta.pushed ? meta.commits : 0,
    changes: changes ?? changesById.get(id),
    prUrl: meta.prUrl,
    issueUrl: meta.issueUrl,
    repoSlug: githubSlug(meta.pushed?.url ?? meta.repo),
    usage: meta.usage,
    provider: meta.provider,
    model: meta.model,
    thinkingLevel: meta.thinking,
    error: meta.error,
    isolation: runtimeInfo.isolation,
    createdAt: meta.createdAt,
    stepStartedAt: meta.createdAt,
    finishedAt: meta.finishedAt,
  };
}

/** The run dir for an id, or undefined when the id is not a run folder. */
function runDir(id: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") return undefined;
  const dir = join(config.runsDir, id);
  return existsSync(join(dir, "meta.json")) ? dir : undefined;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "Session not found" });
}

/** Read a run's meta, or undefined when the file is missing or unreadable. */
function metaOf(dir: string): RunMeta | undefined {
  try {
    return readMeta(dir);
  } catch {
    return undefined;
  }
}

/**
 * A run that started has finished: push its commits when there are any, summarise the changes
 * and tell WebSocket clients how it ended.
 */
async function finishRun(id: string): Promise<void> {
  const dir = runDir(id);
  if (!dir) {
    liveRuns.delete(id);
    return;
  }
  let meta = metaOf(dir);
  if (!meta) {
    liveRuns.delete(id);
    return;
  }

  let pushFailed = false;
  if (meta.status === "done" && meta.commits > 0) {
    publish(id, { type: "hive_status", status: "pushing" });
    try {
      await pushRun(dir);
    } catch (err) {
      const fresh = metaOf(dir) ?? meta;
      fresh.error = (err as Error).message;
      writeMeta(dir, fresh);
      pushFailed = true;
    }
  }

  let changes: ChangeSummary | undefined;
  if (meta.commits > 0) {
    try {
      changes = await changeSummary(dir, meta.base);
    } catch {
      // A change summary is cosmetic: a run without one still ends and is recorded in meta.json.
    }
  }
  if (changes) changesById.set(id, changes);

  const finalMeta = metaOf(dir) ?? meta;
  const done: any = { type: "hive_done", ...runToJSON(id, finalMeta, false, changes) };
  if (pushFailed) done.status = "failed";
  publish(id, done);
  liveRuns.delete(id);
}

export default async function webRunRoutes(app: FastifyInstance) {
  // Start a run (or try to follow one up, which the CLI engine does not support yet).
  app.post("/prompt", { schema: promptSchema }, async (req, reply) => {
    const body = req.body as any;

    if (body.sessionId) return reply.code(400).send({ error: "Follow-ups aren't supported yet" });
    if (body.newRepo) return reply.code(400).send({ error: "New projects aren't supported yet" });
    if ((body.reviewCycles ?? 0) > 0) return reply.code(400).send({ error: "Review cycles aren't supported yet" });
    if (!body.repo) return reply.code(400).send({ error: "Pick a repository" });
    if (liveRuns.size >= config.maxConcurrent) {
      return reply.code(503).send({ error: "All worker bees are busy; try again when a run finishes" });
    }

    let remote: { url: string; name: string; ref?: string };
    try {
      remote = { ...normalizeRepo(body.repo), ref: body.branch };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const abort = new AbortController();
    let id = "";
    let startedMeta: RunMeta | undefined;
    let didStart = false;
    let startResolve!: () => void;
    let startReject!: (err: Error) => void;
    const started = new Promise<void>((resolve, reject) => {
      startResolve = resolve;
      startReject = reject;
    });

    // Don't await the run itself: respond as soon as onStart hands over the run dir and meta.
    const run = startRun({
      remote,
      prompt: body.prompt,
      provider: body.provider,
      model: body.model,
      thinking: body.thinkingLevel,
      signal: abort.signal,
      onEvent: (event) => publish(id, event),
      onStart: (dir, meta) => {
        id = basename(dir);
        startedMeta = meta;
        liveRuns.set(id, { abort, replay: [], listeners: new Set() });
        publish(id, { type: "hive_status", status: "running" });
        didStart = true;
        startResolve();
      },
    });

    void run
      .then(() => finishRun(id))
      .catch((err: unknown) => {
        if (!didStart) {
          startReject(err as Error);
          return;
        }
        const message = (err as Error).message;
        const dir = id ? runDir(id) : undefined;
        const meta = dir ? metaOf(dir) : undefined;
        publish(
          id,
          meta
            ? { type: "hive_done", ...runToJSON(id, meta, false), status: "failed", error: message }
            : { type: "hive_done", status: "failed", error: message },
        );
        liveRuns.delete(id);
      });

    try {
      await started;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    return {
      sessionId: id,
      status: "running",
      repo: remote.url,
      model: startedMeta!.model,
      provider: startedMeta!.provider,
      stepStartedAt: startedMeta!.createdAt,
      finishedAt: undefined,
    };
  });

  app.get("/runs", async () => ({
    runs: listRuns().map(({ name, meta }) => runToJSON(name, meta, liveRuns.has(name))),
    capacity: { running: liveRuns.size, queued: 0, max: config.maxConcurrent },
  }));

  app.get("/status/:sessionId", async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    const dir = runDir(id);
    if (!dir) return notFound(reply);
    const meta = metaOf(dir);
    if (!meta) return notFound(reply);
    return runToJSON(id, meta, liveRuns.has(id));
  });

  app.post("/abort/:sessionId", async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    if (!runDir(id)) return notFound(reply);
    const run = liveRuns.get(id);
    if (!run) return reply.code(409).send({ error: "Run isn't running" });
    run.abort.abort();
    return { sessionId: id, status: "aborted" };
  });

  app.delete("/session/:sessionId", async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    const dir = runDir(id);
    if (!dir) return notFound(reply);
    if (liveRuns.has(id)) return reply.code(409).send({ error: "Run is still going" });
    try {
      cleanRun(dir);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
    changesById.delete(id);
    return { sessionId: id, status: "destroyed" };
  });

  // Open a pull request from the run's pushed branch (only when the user clicks).
  app.post("/pr/:sessionId", async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    const dir = runDir(id);
    if (!dir) return notFound(reply);
    try {
      return { sessionId: id, url: await openPr(dir) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Post a no-change review to a GitHub issue (only when the user clicks).
  app.post("/issue/:sessionId", async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    const dir = runDir(id);
    if (!dir) return notFound(reply);
    const meta = metaOf(dir);
    if (!meta) return notFound(reply);
    const slug = githubSlug(meta.repo);
    if (!slug) return reply.code(400).send({ error: "Issues need a github.com repository" });
    try {
      const url = await openIssue({
        slug,
        title: "Review: " + runToJSON(id, meta, liveRuns.has(id)).title,
        body: issueBody(meta.summary ?? "", { model: meta.model, baseSha: meta.base }),
      });
      const fresh = metaOf(dir) ?? meta;
      fresh.issueUrl = url;
      writeMeta(dir, fresh);
      return { sessionId: id, url };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // One-time ticket for opening /events/:sessionId from a browser (which can't send headers).
  app.post("/events/:sessionId/ticket", async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    if (!runDir(id)) return notFound(reply);
    return { ticket: issueTicket(req.hiveUser!, id) };
  });

  app.get("/events/:sessionId", { websocket: true }, (socket, req: FastifyRequest) => {
    const id = (req.params as any).sessionId as string;
    const dir = runDir(id);
    if (!dir) {
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

    const live = liveRuns.get(id);
    if (live) {
      for (const event of live.replay) send(event);
      live.listeners.add(send);
      socket.on("close", () => live.listeners.delete(send));
      return;
    }

    // A finished run: replay the events the VM wrote, then the closing hive_done.
    const meta = metaOf(dir);
    if (!meta) {
      socket.close(4004, "Session not found");
      return;
    }
    let text = "";
    try {
      text = readFileSync(join(dir, "io", "events.jsonl"), "utf8");
    } catch {
      // no event log: still send the hive_done below
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        send(JSON.parse(trimmed));
      } catch {
        // skip a half-written line
      }
    }
    send({ type: "hive_done", ...runToJSON(id, meta, false) });
  });
}
