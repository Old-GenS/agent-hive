/**
 * The web UI's run API, backed by the CLI run engine (`src/runs.ts`). A run is a folder under
 * `config.runsDir`; its id is the folder name. Runs started by this process live in an in-memory
 * registry, so a live run can be aborted and its events replayed to WebSocket clients; finished
 * runs are read back from meta.json and io/events.jsonl.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { issueTicket } from "./auth.js";
import { config, PROVIDERS } from "./config.js";
import { changeSummary, githubSlug, issueBody, normalizeRepo, openIssue, type ChangeSummary } from "./git.js";
import { runtimeInfo } from "./sandbox.js";
import { readVmFileOrEmpty } from "./vmfiles.js";
import {
  cleanRun,
  continueRun,
  exportRun,
  isLive,
  listRuns,
  openPr,
  pushRun,
  readMeta,
  reportMarkdown,
  setKept,
  startRun,
  writeMeta,
  type RunMeta,
} from "./runs.js";

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
      instructions: { type: "string", maxLength: 20_000 },
      instructionsMode: { type: "string", enum: ["add", "replace"] },
      reviewCycles: { type: "integer", minimum: 0, maximum: 5 },
      reviewModel: { type: "string", maxLength: 200 },
      offline: { type: "boolean" },
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

/** `PUT /session/:id/kept`: the star toggle. */
const keptSchema = {
  body: {
    type: "object",
    required: ["kept"],
    additionalProperties: false,
    properties: {
      kept: { type: "boolean" },
    },
  },
} as const;

/** `POST /sessions/clear`: which finished runs to delete; "done" is the default. */
const clearSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      include: { type: "string", enum: ["done", "finished"] },
    },
  },
} as const;

/** How many runs may be in progress at once, with a FIFO queue behind them. */
export interface Slots {
  acquire(signal: AbortSignal): Promise<void>;
  release(): void;
  running(): number;
  queued(): number;
  /** Change how many runs may be in progress (raising it starts queued waiters). */
  setMax(n: number): void;
}

/** A fixed number of run slots, handed out FIFO. An aborted waiter leaves the queue. */
export function createSlots(max: number): Slots {
  let running = 0;
  let limit = max;
  interface Waiter {
    resolve: () => void;
    reject: (err: Error) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }
  const waiters: Waiter[] = [];
  const abortError = () => new Error("aborted while queued");

  /** Start queued waiters while there is room; an aborted one leaves the queue without a slot. */
  function startWaiting(): void {
    while (running < limit && waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError());
        continue;
      }
      running++;
      waiter.resolve();
    }
  }

  return {
    acquire(signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(abortError());
      if (running < limit) {
        running++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal, onAbort: () => {} };
        waiter.onAbort = () => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    release(): void {
      if (running > 0) running--;
      startWaiting();
    },
    running: () => running,
    queued: () => waiters.length,
    setMax(n: number): void {
      // Raising starts queued waiters; lowering lets running runs finish and new ones wait.
      limit = n;
      startWaiting();
    },
  };
}

const slots = createSlots(config.maxConcurrent);

/** Change how many runs may be in progress; new runs use it right away, no restart. */
export function setMaxConcurrent(n: number): void {
  config.maxConcurrent = n;
  slots.setMax(n);
}

/** A run started by this process, so its events are still in memory. */
interface LiveRun {
  abort: AbortController;
  replay: any[];
  listeners: Set<(event: any) => void>;
  /** this run holds a slot (and must release it exactly once when it ends) */
  acquired: boolean;
  /** it had to wait for a free slot */
  waiting: boolean;
}

const liveRuns = new Map<string, LiveRun>();
const changesById = new Map<string, ChangeSummary>();

function liveEntry(abort: AbortController): LiveRun {
  return { abort, replay: [], listeners: new Set(), acquired: false, waiting: false };
}

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

/** The real number of running and queued runs (for `/runs` and `/capacity`). */
export function capacity(): { running: number; queued: number; max: number } {
  return { running: slots.running(), queued: slots.queued(), max: config.maxConcurrent };
}

/** Wait for a free slot, telling the UI when the run has to queue. */
function waitForSlot(id: string, live: LiveRun, signal: AbortSignal): Promise<void> {
  if (slots.running() >= config.maxConcurrent) {
    live.waiting = true;
    publish(id, { type: "hive_status", status: "queued", running: slots.running(), max: config.maxConcurrent });
  }
  return slots.acquire(signal).then(() => {
    live.acquired = true;
  });
}

/** Release a run's slot, at most once. */
function releaseLive(live: LiveRun): void {
  if (!live.acquired) return;
  live.acquired = false;
  slots.release();
}

/** The UI's status for a run folder: live runs are running, otherwise it follows meta.json. */
export function uiStatus(
  meta: RunMeta,
  live: boolean,
): "queued" | "running" | "idle" | "failed" | "aborted" {
  if (live) return meta.status === "queued" ? "queued" : "running";
  if (meta.status === "done") return "idle";
  if (meta.status === "failed") return "failed";
  if (meta.status === "aborted") return "aborted";
  // A run still marked "running"/"queued" whose process is gone (server/CLI restarted) never finished.
  return "failed";
}

/** A one-line title for the run list: the prompt's first non-empty line, at most 80 characters. */
function runTitle(meta: RunMeta): string {
  const lines = meta.prompt.split("\n");
  const index = lines.findIndex((candidate) => candidate.trim().length > 0);
  if (index === -1) return "";
  const trimmed = lines[index].trim();
  // meta.prompt keeps only the first 200 characters of the prompt: a first line that reaches the
  // end of them was cut, so say so.
  const cut = meta.prompt.length >= 200 && index === lines.length - 1;
  return cut ? trimmed.trimEnd() + "\u2026" : trimmed;
}

/** One run in the shapes the web UI reads (the old `Task.toJSON()`, backed by meta.json). */
/**
 * What a run was started with that the run page shows: its own instructions (added to or
 * replacing the default) and, for an offline run, the hosts its VM may reach.
 */
export function runSettingsJSON(meta: RunMeta): {
  instructions: "added" | "replaced" | null;
  instructionsText: string;
  offlineHosts: string[];
} {
  return {
    instructions: meta.instructions ?? null,
    instructionsText: meta.instructionsText ?? "",
    offlineHosts: meta.offline === true ? [...(PROVIDERS[meta.provider]?.apiHosts ?? [])] : [],
  };
}

export function runToJSON(id: string, meta: RunMeta, live: boolean, changes?: ChangeSummary) {
  return {
    sessionId: id,
    title: runTitle(meta),
    status: uiStatus(meta, live),
    isStreaming: live,
    repo: meta.repo,
    newRepo: meta.newRepo?.name,
    createdRepo: meta.createdRepo,
    resultBranch: meta.pushed?.branch,
    commitsPushed: meta.pushed ? meta.commits : 0,
    /** the run's commits were never pushed because the push failed: the UI offers Push again */
    pushFailed: Boolean(
      meta.commits > 0 &&
        // pushError marks runs from this version on; older runs only have the push's error text.
        (meta.pushError === true ||
          /GitHub refused the push|failed to push some refs|remote rejected|check your git credentials/.test(meta.error ?? "")) &&
        (!meta.pushed || meta.pushed.at < (meta.finishedAt ?? 0)),
    ),
    /** the run's commits that hive never pushed: what deleting it would lose */
    unpushedCommits: meta.commits > 0 && meta.pushed === undefined ? meta.commits : 0,
    /** starred: skipped by retention and Clear */
    kept: Boolean(meta.kept),
    changes: changes ?? changesById.get(id) ?? meta.changes,
    commits: meta.commits,
    prUrl: meta.prUrl,
    issueUrl: meta.issueUrl,
    repoSlug: meta.createdRepo ?? githubSlug(meta.pushed?.url ?? meta.repo),
    usage: meta.usage,
    provider: meta.provider,
    model: meta.model,
    offline: meta.offline === true,
    ...runSettingsJSON(meta),
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
      await pushRun(dir, { update: meta.pushed !== undefined });
      // A push that worked clears an earlier failure's flag and message.
      const pushed = metaOf(dir);
      if (pushed?.pushError) {
        delete pushed.pushError;
        delete pushed.error;
        writeMeta(dir, pushed);
      }
    } catch (err) {
      const fresh = metaOf(dir) ?? meta;
      fresh.error = (err as Error).message;
      fresh.pushError = true;
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
  // Kept in meta.json too, so the commit and file lists survive a server restart.
  if (changes) {
    finalMeta.changes = changes;
    writeMeta(dir, finalMeta);
  }
  const done: any = { type: "hive_done", ...runToJSON(id, finalMeta, false, changes) };
  if (pushFailed) done.status = "failed";
  publish(id, done);
  liveRuns.delete(id);
}

/** Finish a live run and release its slot, whichever way it ended. */
async function endRun(id: string): Promise<void> {
  const live = liveRuns.get(id);
  try {
    await finishRun(id);
  } finally {
    if (live) releaseLive(live);
  }
}

/** Continue a finished run in the same session. */
async function followUp(body: any, reply: FastifyReply) {
  const id = body.sessionId as string;
  const dir = runDir(id);
  if (!dir) return notFound(reply);
  const meta = metaOf(dir);
  if (!meta) return notFound(reply);
  if (liveRuns.has(id) || isLive(meta)) {
    return reply.code(409).send({ error: "Session is still going; wait for it to finish or abort it" });
  }

  const abort = new AbortController();
  const live = liveEntry(abort);
  liveRuns.set(id, live);

  const run = continueRun(dir, {
    prompt: body.prompt,
    signal: abort.signal,
    onEvent: (event) => publish(id, event),
    onStatus: (status, extra) => publish(id, { type: "hive_status", status, ...extra }),
    waitTurn: (signal) => waitForSlot(id, live, signal),
  });
  void run
    .then(() => endRun(id))
    .catch((err: unknown) => {
      const message = (err as Error).message;
      const fresh = metaOf(dir) ?? meta;
      publish(id, { type: "hive_done", ...runToJSON(id, fresh, false), status: "failed", error: message });
      liveRuns.delete(id);
      releaseLive(live);
    });

  return {
    sessionId: id,
    status: live.waiting ? "queued" : "running",
    repo: meta.repo,
    stepStartedAt: meta.createdAt,
    finishedAt: undefined,
  };
}

export default async function webRunRoutes(app: FastifyInstance) {
  // Start a run, or continue a finished one with a follow-up prompt.
  app.post("/prompt", { schema: promptSchema }, async (req, reply) => {
    const body = req.body as any;
    if (body.sessionId) return followUp(body, reply);

    if (body.repo && body.newRepo) {
      return reply.code(400).send({ error: "Send repo or newRepo, not both" });
    }
    if (!body.repo && !body.newRepo) {
      return reply.code(400).send({ error: "Pick a repository" });
    }

    let remote: { url: string; name: string; ref?: string } | undefined;
    if (body.repo) {
      try {
        remote = { ...normalizeRepo(body.repo), ref: body.branch };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }

    const abort = new AbortController();
    let id = "";
    let startedMeta: RunMeta | undefined;
    let live: LiveRun | undefined;
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
      newRepo: body.newRepo ? { name: body.newRepo.name, private: body.newRepo.private ?? true } : undefined,
      prompt: body.prompt,
      provider: body.provider,
      model: body.model,
      thinking: body.thinkingLevel,
      systemPrompt: body.systemPromptOverride,
      instructions: body.instructions,
      instructionsMode: body.instructionsMode,
      reviewCycles: body.reviewCycles,
      reviewModel: body.reviewModel,
      offline: body.offline === true,
      signal: abort.signal,
      onEvent: (event) => publish(id, event),
      onStatus: (status, extra) => publish(id, { type: "hive_status", status, ...extra }),
      waitTurn: (signal) => waitForSlot(id, live!, signal),
      onStart: (dir, meta) => {
        id = basename(dir);
        startedMeta = meta;
        live = liveEntry(abort);
        liveRuns.set(id, live);
        didStart = true;
        startResolve();
      },
    });

    void run
      .then(() => endRun(id))
      .catch((err: unknown) => {
        if (!didStart || !live) {
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
        releaseLive(live);
      });

    try {
      await started;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    return {
      sessionId: id,
      status: live?.waiting ? "queued" : "running",
      repo: startedMeta!.repo,
      model: startedMeta!.model,
      provider: startedMeta!.provider,
      offline: startedMeta!.offline === true,
      ...runSettingsJSON(startedMeta!),
      newRepo: body.newRepo?.name,
      stepStartedAt: startedMeta!.createdAt,
      finishedAt: undefined,
    };
  });

  app.get("/runs", async () => ({
    runs: listRuns().map(({ name, meta }) => runToJSON(name, meta, liveRuns.has(name))),
    capacity: capacity(),
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

  // Star or unstar a run: a kept run is skipped by retention and by Clear. Works on live runs too.
  app.put("/session/:sessionId/kept", { schema: keptSchema }, async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    const dir = runDir(id);
    if (!dir) return notFound(reply);
    const { kept } = req.body as { kept: boolean };
    const meta = setKept(dir, kept);
    return { sessionId: id, kept: Boolean(meta.kept) };
  });

  // Delete every finished run in one go: "done" (default) or every finished run, except starred
  // ones and runs that are still going. A run left behind by a crashed hive counts as finished.
  app.post("/sessions/clear", { schema: clearSchema }, async (req, reply) => {
    const include = (req.body as { include?: "done" | "finished" } | undefined)?.include ?? "done";
    const deleted: string[] = [];
    const skipped: { id: string; error: string }[] = [];
    for (const { name, dir, meta } of listRuns()) {
      if (liveRuns.has(name) || isLive(meta)) continue;
      if (meta.kept) continue;
      if (include === "done" && meta.status !== "done") continue;
      try {
        cleanRun(dir);
      } catch (err) {
        skipped.push({ id: name, error: (err as Error).message });
        continue;
      }
      changesById.delete(name);
      deleted.push(name);
    }
    return reply.send({ deleted, skipped });
  });

  // Push a finished run's commits again, after a push that failed (the UI's Push again button).
  // The same host-side push as the automatic one at the end of a run.
  app.post("/push/:sessionId", async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    const dir = runDir(id);
    if (!dir) return notFound(reply);
    const meta = metaOf(dir);
    if (!meta) return notFound(reply);
    if (liveRuns.has(id) || isLive(meta)) {
      return reply.code(409).send({ error: "Session is still going; wait for it to finish or abort it" });
    }
    if (!(meta.commits > 0)) return reply.code(409).send({ error: "This run has no commits to push" });
    try {
      const pushed = await pushRun(dir, { update: meta.pushed !== undefined });
      const fresh = metaOf(dir) ?? meta;
      // The work itself was fine: the failed push is no longer the run's error.
      if (fresh.pushError) {
        delete fresh.pushError;
        delete fresh.error;
        writeMeta(dir, fresh);
      }
      publish(id, { type: "hive_done", ...runToJSON(id, fresh, false) });
      return { sessionId: id, pushed };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
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

  // Download a finished run's result, built from its patches in a fresh clone of the trusted
  // source (never from the agent's work/ copy): a zip of the files, a git bundle of the commits,
  // or a Markdown report built from the run's meta.json.
  app.get("/export/:sessionId", async (req, reply) => {
    const id = (req.params as any).sessionId as string;
    const dir = runDir(id);
    if (!dir) return notFound(reply);
    const format = (req.query as any)?.format;
    if (format !== "zip" && format !== "bundle" && format !== "report") {
      return reply.code(400).send({ error: "format must be zip, bundle or report" });
    }
    const meta = metaOf(dir);
    if (!meta) return notFound(reply);
    if (liveRuns.has(id) || isLive(meta)) return reply.code(409).send({ error: "Run is still going" });

    if (format === "report") {
      reply.header("Content-Type", "text/markdown; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${id}.md"`);
      return reply.send(reportMarkdown(id, meta));
    }

    const ext = format === "zip" ? "zip" : "bundle";
    const tmp = mkdtempSync(join(tmpdir(), "hive-export-"));
    let data = Buffer.alloc(0);
    try {
      const outPath = join(tmp, `run.${ext}`);
      try {
        await exportRun(dir, format, outPath);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      data = readFileSync(outPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    reply.header("Content-Type", format === "zip" ? "application/zip" : "application/x-git-bundle");
    reply.header("Content-Disposition", `attachment; filename="${id}.${ext}"`);
    return reply.send(data);
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

    // A finished run: replay every step's events in order, then the closing hive_done.
    const meta = metaOf(dir);
    if (!meta) {
      socket.close(4004, "Session not found");
      return;
    }
    const ioDir = join(dir, "io");
    let names: string[] = [];
    try {
      names = readdirSync(ioDir);
    } catch {
      // no event logs: still send the hive_done below
    }
    const stepFiles = names
      .map((name) => ({ name, n: /^events-(\d+)\.jsonl$/.exec(name)?.[1] }))
      .filter((file): file is { name: string; n: string } => file.n !== undefined)
      .sort((a, b) => Number(a.n) - Number(b.n))
      .map((file) => file.name);
    for (const name of [...stepFiles, "events.jsonl"]) {
      let text = "";
      try {
        // io/ is VM-writable: only read a regular file, never a planted symlink or FIFO.
        text = readVmFileOrEmpty(join(ioDir, name));
      } catch {
        continue;
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
    }
    send({ type: "hive_done", ...runToJSON(id, meta, false) });
  });
}
