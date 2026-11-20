/// <reference types="vite/client" />
/**
 * hive UI: Runs (new-run form with a per-provider model list, live run timeline, Stop and
 * follow-ups) and Settings (API key status and defaults, read-only for now).
 *
 * Everything from the server, GitHub or the agent is rendered as text, except the output of
 * formatContent(), which escapes first and only then adds a fixed set of formatting tags.
 */
import "./app.css";
import { createBeeIndicator, headerBee, miniHive, type BeeIndicator, type BeeState } from "./bee.js";
import { api, clearToken, el, esc, getToken, saveToken, setToken, serverUrl } from "./util.js";

// ── types ──

interface ProviderEntry {
  id: string;
  label: string;
  hasKey: boolean;
  model: string | null;
}

interface ProviderInfoResponse {
  default: {
    provider: string | null;
    providerSource: string | null;
    model: string | null;
    modelSource: string | null;
    thinking: string;
  };
  providers: ProviderEntry[];
}

type Status = "queued" | "cloning" | "running" | "reviewing" | "pushing" | "idle" | "failed" | "aborted";

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  cloning: "Cloning",
  running: "Working",
  reviewing: "Reviewing",
  pushing: "Pushing",
  idle: "Done",
  failed: "Failed",
  aborted: "Stopped",
};

const STATUS_PILL: Record<string, string> = {
  queued: "pill-warn",
  cloning: "pill-accent",
  running: "pill-accent",
  reviewing: "pill-accent",
  pushing: "pill-accent",
  idle: "pill-ok",
  failed: "pill-danger",
  aborted: "pill-warn",
};

const BUSY_STATUS = new Set(["queued", "cloning", "running", "reviewing", "pushing"]);

/** Same rule as the server's validateRepoName. */
function validRepoName(name: string): boolean {
  const trimmed = name.trim();
  return (
    /^[A-Za-z0-9_.-]{1,100}$/.test(trimmed) &&
    !trimmed.startsWith(".") &&
    !trimmed.startsWith("-") &&
    !trimmed.endsWith(".git") &&
    trimmed !== "." &&
    trimmed !== ".."
  );
}

/** What the bee indicator shows for each run status. */
const BEE_STATE: Record<Status, { state: BeeState; label: string }> = {
  queued: { state: "queued", label: "Waiting for a free microVM" },
  cloning: { state: "working", label: "Cloning the repo" },
  running: { state: "working", label: "Agent working in the microVM" },
  reviewing: { state: "working", label: "Reviewing the changes" },
  pushing: { state: "working", label: "Pushing changes" },
  idle: { state: "done", label: "Back at the hive" },
  failed: { state: "failed", label: "The bee came back empty-handed" },
  aborted: { state: "stopped", label: "Called back to the hive" },
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

type Tone = "ok" | "warn" | "danger";

interface AssistantItem {
  kind: "assistant";
  text: string;
}

/** A timeline status line; hive_status steps carry `step` so earlier ones tick off. */
interface StatusItem {
  kind: "status";
  text: string;
  step?: "current" | "done" | "failed";
}

interface ToolItem {
  kind: "tool";
  name: string;
  detail: string;
  failed: boolean;
}

type RunItem =
  | StatusItem
  | { kind: "user"; text: string }
  | AssistantItem
  | ToolItem
  | {
      kind: "banner";
      tone: Tone;
      title: string;
      detail: string;
      link?: { href: string; label: string };
      changes?: Changes;
      /** set when this run's branch can become a pull request */
      pr?: { state: "ready" | "opening" | "open" | "error"; url?: string; error?: string };
      /** set when a review that changed nothing can be posted as an issue */
      issue?: { state: "ready" | "opening" | "open" | "error"; url?: string; error?: string };
    };

/** What a run's push changed, from hive_done (agent-controlled text: render as text only). */
interface Changes {
  commits: string[];
  files: { path: string; added: number | null; removed: number | null }[];
  moreFiles: number;
}

function parseChanges(raw: unknown): Changes | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const commits = Array.isArray(r.commits) ? r.commits.filter((c): c is string => typeof c === "string") : [];
  const files = Array.isArray(r.files)
    ? r.files
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && typeof (f as any).path === "string")
        .map((f) => ({
          path: f.path as string,
          added: typeof f.added === "number" ? f.added : null,
          removed: typeof f.removed === "number" ? f.removed : null,
        }))
    : [];
  if (!commits.length && !files.length) return undefined;
  return { commits, files, moreFiles: typeof r.moreFiles === "number" ? r.moreFiles : 0 };
}

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

function prElement(item: Extract<RunItem, { kind: "banner" }>): HTMLElement {
  const pr = item.pr!;
  const box = el("div", { class: "pr-actions" });
  if (pr.state === "open" && pr.url && PR_URL.test(pr.url)) {
    box.append(
      el("a", { class: "btn btn-primary", id: "prLink", href: pr.url, target: "_blank", rel: "noopener noreferrer" }, "View pull request"),
    );
    return box;
  }
  const button = el(
    "button",
    { class: "btn btn-primary", id: "openPrBtn", type: "button" },
    pr.state === "opening" ? "Opening pull request…" : "Open pull request",
  );
  button.disabled = pr.state === "opening";
  button.onclick = () => void openPr(item);
  box.append(button, el("span", { class: "pr-hint" }, "Uses the agent's write-up and the change list as the description."));
  if (pr.state === "error" && pr.error) box.append(el("p", { class: "alert alert-danger" }, pr.error));
  return box;
}

async function openPr(item: Extract<RunItem, { kind: "banner" }>): Promise<void> {
  if (!run || !item.pr || item.pr.state === "opening") return;
  const sessionId = run.sessionId;
  item.pr = { state: "opening" };
  updateItem(item);
  try {
    const res = await api(`/pr/${encodeURIComponent(sessionId)}`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
    if (!res.ok || typeof data.url !== "string") {
      throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
    }
    item.pr = { state: "open", url: data.url };
  } catch (err) {
    item.pr = { state: "error", error: err instanceof Error ? err.message : String(err) };
  }
  updateItem(item);
}

const ISSUE_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/;

function issueElement(item: Extract<RunItem, { kind: "banner" }>): HTMLElement {
  const issue = item.issue!;
  const box = el("div", { class: "pr-actions" });
  if (issue.state === "open" && issue.url && ISSUE_URL.test(issue.url)) {
    box.append(
      el("a", { class: "btn btn-primary", id: "issueLink", href: issue.url, target: "_blank", rel: "noopener noreferrer" }, "View issue"),
    );
    return box;
  }
  const button = el(
    "button",
    { class: "btn btn-primary", id: "postIssueBtn", type: "button" },
    issue.state === "opening" ? "Posting review…" : "Post review as an issue",
  );
  button.disabled = issue.state === "opening";
  button.onclick = () => void postIssue(item);
  box.append(button, el("span", { class: "pr-hint" }, "Puts the agent's write-up into a new GitHub issue on this repo."));
  if (issue.state === "error" && issue.error) box.append(el("p", { class: "alert alert-danger" }, issue.error));
  return box;
}

async function postIssue(item: Extract<RunItem, { kind: "banner" }>): Promise<void> {
  if (!run || !item.issue || item.issue.state === "opening") return;
  const sessionId = run.sessionId;
  item.issue = { state: "opening" };
  updateItem(item);
  try {
    const res = await api(`/issue/${encodeURIComponent(sessionId)}`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
    if (!res.ok || typeof data.url !== "string") {
      throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
    }
    item.issue = { state: "open", url: data.url };
  } catch (err) {
    item.issue = { state: "error", error: err instanceof Error ? err.message : String(err) };
  }
  updateItem(item);
}

function changesElement(changes: Changes): HTMLElement {
  const box = el("div", { class: "changes" });
  if (changes.commits.length) {
    box.append(el("h3", { class: "changes-title" }, `Commits (${changes.commits.length})`));
    box.append(el("ul", { class: "changes-commits" }, ...changes.commits.map((c) => el("li", {}, c))));
  }
  if (changes.files.length) {
    const total = changes.files.length + changes.moreFiles;
    box.append(el("h3", { class: "changes-title" }, `Files changed (${total})`));
    const list = el("ul", { class: "changes-files" });
    for (const f of changes.files) {
      const stats =
        f.added === null || f.removed === null
          ? el("span", { class: "changes-binary" }, "binary")
          : el(
              "span",
              { class: "changes-stats" },
              el("span", { class: "changes-added" }, `+${f.added}`),
              el("span", { class: "changes-removed" }, `\u2212${f.removed}`),
            );
      list.append(el("li", {}, el("span", { class: "changes-path" }, f.path), stats));
    }
    if (changes.moreFiles > 0) list.append(el("li", { class: "cell-muted" }, `and ${changes.moreFiles} more`));
    box.append(list);
  }
  return box;
}

interface RunState {
  sessionId: string;
  repo: string | null;
  /** the project name for a run that starts from an empty repo */
  newRepo: string | null;
  providerLabel: string;
  model: string;
  title: string;
  status: Status;
  busy: boolean;
  items: RunItem[];
  ws: WebSocket | null;
  currentAssistant: AssistantItem | null;
  currentStep: StatusItem | null;
  lastTool: ToolItem | null;
  /** a saved PR/issue URL from GET /status, shown on the replay's hive_done banner */
  pendingPrUrl?: string;
  pendingIssueUrl?: string;
  /** when the current step started, for the bee's timer */
  stepStartedAt?: number;
  /** when the run finished, for the bee's real duration */
  finishedAt?: number;
}

/** One row of GET /runs: what the run list shows. */
interface RunSummary {
  sessionId: string;
  title: string;
  status: Status;
  repo: string | null;
  newRepo: string | null;
  model: string;
  provider: string;
  createdAt: number;
  lastActivity: number;
  stepStartedAt?: number;
  finishedAt?: number;
}

function parseRunSummary(raw: unknown): RunSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || !r.sessionId) return null;
  const status = typeof r.status === "string" && r.status in STATUS_LABEL ? (r.status as Status) : "idle";
  return {
    sessionId: r.sessionId,
    title: typeof r.title === "string" ? r.title : "",
    status,
    repo: typeof r.repo === "string" && r.repo ? r.repo : null,
    newRepo: typeof r.newRepo === "string" && r.newRepo ? r.newRepo : null,
    model: typeof r.model === "string" ? r.model : "",
    provider: typeof r.provider === "string" ? r.provider : "",
    createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    lastActivity: typeof r.lastActivity === "number" ? r.lastActivity : Date.now(),
    stepStartedAt: typeof r.stepStartedAt === "number" ? r.stepStartedAt : undefined,
    finishedAt: typeof r.finishedAt === "number" ? r.finishedAt : undefined,
  };
}

/** github.com URLs read better as owner/name. */
function shortRepo(repo: string | null): string {
  return (repo ?? "").replace(/^(?:https:\/\/github\.com\/|git@github\.com:)/, "").replace(/\.git$/, "");
}

function repoLabel(repo: string | null, newRepo: string | null): string {
  if (newRepo) return `new project ${newRepo}`;
  return shortRepo(repo) || "no repo";
}

/** mm:ss (or h:mm:ss) for a run that is still going. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function runTimeLabel(summary: RunSummary): string {
  if (BUSY_STATUS.has(summary.status)) return formatElapsed(Date.now() - (summary.stepStartedAt ?? summary.createdAt));
  const minutes = Math.max(0, Math.floor((Date.now() - summary.lastActivity) / 60000));
  return `${minutes} min ago`;
}

interface RunUi {
  pill: HTMLElement;
  stopBtn: HTMLButtonElement;
  newBtn: HTMLButtonElement;
  timeline: HTMLOListElement;
  nodes: Map<RunItem, HTMLElement>;
  followInput: HTMLTextAreaElement;
  followBtn: HTMLButtonElement;
  empty: HTMLElement | null;
  bee: BeeIndicator;
}

// ── state ──

const $app = document.getElementById("app")!;

let providers: ProviderInfoResponse | null = null;
let providersFailed = false;
let choices = { provider: "", model: "", thinking: "" };

let mainEl: HTMLElement | null = null;
let runsEl: HTMLElement | null = null;
let runsListEl: HTMLElement | null = null;
let runsViewEl: HTMLElement | null = null;
let settingsEl: HTMLElement | null = null;
let navRunsEl: HTMLButtonElement | null = null;
let navSettingsEl: HTMLButtonElement | null = null;
let headerBeeEl: HTMLElement | null = null;

let run: RunState | null = null;
let runUi: RunUi | null = null;

/** The latest GET /runs answer, and the signature last rendered (to skip identical re-renders). */
let runList: RunSummary[] | null = null;
let runListSignature = "";
let runsExpanded = false;
let runsPollTimer: number | undefined;
let runsFetchSeq = 0;
/** What the Runs page's right-hand pane currently shows: "#runs", a session id, or null. */
let runsViewTarget: string | null = null;
let openRunSeq = 0;

const RUNS_POLL_MS = 3000;
const MAX_VISIBLE_RUNS = 5;

// ── small helpers ──

const SVG_NS = "http://www.w3.org/2000/svg";

function svgNode(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

/** The mockup's hexagon mark: an outline hexagon with a solid accent hexagon inside. */
function hiveLogo(): SVGSVGElement {
  const svg = svgNode("svg", { width: "24", height: "24", viewBox: "0 0 28 28", "aria-hidden": "true" });
  svg.append(
    svgNode("path", {
      d: "M14 3l9.5 5.5v11L14 25l-9.5-5.5v-11z",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linejoin": "round",
    }),
    svgNode("path", { d: "M14 9l4.8 2.8v5.4L14 20l-4.8-2.8v-5.4z", fill: "var(--accent)" }),
  );
  return svg as SVGSVGElement;
}

/** Offer the first line of the task as the run title, capped at 120 characters. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? text;
  const trimmed = line.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 199).trimEnd() + "\u2026" : trimmed;
}

/**
 * Keep the old renderer: escape first, then add only these fixed tags. The result is the only
 * non-constant value ever assigned with innerHTML.
 */
function formatContent(text: string): string {
  return esc(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function nearBottom(): boolean {
  const doc = document.documentElement;
  return doc.scrollHeight - (window.scrollY + window.innerHeight) < 120;
}

function scrollToBottom(): void {
  window.scrollTo({ top: document.documentElement.scrollHeight });
}

// ── auth ──

async function validateToken(): Promise<{ name: string } | null> {
  try {
    const res = await api("/api/user");
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * `hive serve --open` logs the browser in with a token in the URL fragment. Take it before the
 * login check and strip it from the address bar and history entry (fragments never reach the
 * server). An invalid token is handled like one typed into the login form.
 */
function takeTokenFromHash(): void {
  if (!location.hash.startsWith("#token=")) return;
  const raw = location.hash.slice("#token=".length);
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Keep the raw value; the login check will reject it if it isn't a token.
  }
  history.replaceState(null, "", "#runs");
  if (!value) return;
  setToken(value);
  saveToken();
}

function renderLogin(showError = false): void {
  mainEl = null;
  const tokenInput = el("input", {
    id: "token",
    type: "password",
    autocomplete: "current-password",
    placeholder: "API token",
    "aria-label": "API token",
  });
  const errorEl = el("p", { class: "login-error", role: "alert" }, showError ? "That token didn't work" : "");
  const button = el("button", { id: "loginBtn", class: "btn btn-primary", type: "submit" }, "Continue");
  const form = el(
    "form",
    { class: "login-card" },
    el("div", { class: "login-brand" }, hiveLogo(), "hive"),
    el("p", { class: "login-lead" }, "Enter your API token"),
    tokenInput,
    button,
    errorEl,
  );

  const submit = async (event: Event) => {
    event.preventDefault();
    const value = tokenInput.value.trim();
    if (!value) return;
    setToken(value);
    const user = await validateToken();
    if (!user) {
      tokenInput.value = "";
      renderLogin(true);
      return;
    }
    saveToken();
    await enterApp(user);
  };
  form.addEventListener("submit", (event) => void submit(event));

  $app.replaceChildren(el("div", { class: "login-screen" }, form));
  tokenInput.focus();
}

async function enterApp(user: { name: string }): Promise<void> {
  await loadProviders();
  renderApp(user);
}

async function loadProviders(): Promise<void> {
  providersFailed = false;
  try {
    const res = await api("/api/providers");
    if (!res.ok) throw new Error(`status ${res.status}`);
    providers = (await res.json()) as ProviderInfoResponse;
  } catch {
    providers = null;
    providersFailed = true;
  }
}

// ── app shell and routing ──

function renderApp(user: { name: string }): void {
  runsEl = null;
  settingsEl = null;
  navRunsEl = el("button", { id: "nav-runs", class: "nav-btn", type: "button" }, "Runs");
  navSettingsEl = el("button", { id: "nav-settings", class: "nav-btn", type: "button" }, "Settings");
  navRunsEl.onclick = () => {
    location.hash = "#runs";
  };
  navSettingsEl.onclick = () => {
    location.hash = "#settings";
  };
  const logout = el("button", { id: "logoutBtn", class: "btn btn-small btn-ghost icon-btn", type: "button" });
  logout.append(logoutIcon());
  // The signed-in name shows in the tooltip instead of taking space in the header.
  logout.title = `Log out (current user: ${user.name})`;
  logout.setAttribute("aria-label", `Log out (current user: ${user.name})`);
  logout.onclick = () => {
    stopRunsPolling();
    stopUsagePolling();
    closeRun();
    headerBeeEl = null;
    runsEl = null;
    runsListEl = null;
    runsViewEl = null;
    runsViewTarget = null;
    runList = null;
    runListSignature = "";
    runsExpanded = false;
    settingsEl = null;
    mainEl = null;
    providers = null;
    providersFailed = false;
    clearToken();
    renderLogin();
  };

  const header = el(
    "header",
    { class: "header" },
    el(
      "div",
      { class: "header-inner" },
      el("div", { class: "brand" }, hiveLogo(), "hive"),
      el("nav", { "aria-label": "Main" }, navRunsEl, navSettingsEl),
      el("div", { class: "header-user" }, themeButton(), logout),
    ),
  );
  mainEl = el("main", { class: "main" });
  $app.replaceChildren(header, mainEl);

  if (!location.hash) history.replaceState(null, "", "#runs");
  route();
}

/** Close the run on screen: socket and bee indicator only; the task keeps going on the server. */
function closeRun(): void {
  run?.ws?.close();
  runUi?.bee.destroy();
  run = null;
  runUi = null;
}

/** The Runs page shell: the run list on the left, the form or a run on the right. Built once. */
function runsPage(): HTMLElement {
  if (runsEl) return runsEl;
  runsListEl = el("aside", { class: "runs-list", "aria-label": "Runs" });
  runsViewEl = el("div", { class: "runs-view" });
  runsEl = el("div", { class: "runs-layout" }, runsListEl, runsViewEl);
  startRunsPolling();
  return runsEl;
}

function runStateFromStatus(status: Record<string, unknown>): RunState {
  const providerId = typeof status.provider === "string" ? status.provider : "";
  const runStatus =
    typeof status.status === "string" && status.status in STATUS_LABEL ? (status.status as Status) : "queued";
  return {
    sessionId: String(status.sessionId ?? ""),
    repo: typeof status.repo === "string" && status.repo ? status.repo : null,
    newRepo: typeof status.newRepo === "string" && status.newRepo ? status.newRepo : null,
    providerLabel: providers?.providers.find((p) => p.id === providerId)?.label ?? providerId,
    model: typeof status.model === "string" ? status.model : "",
    title: typeof status.title === "string" && status.title ? status.title : "Untitled run",
    status: runStatus,
    busy: BUSY_STATUS.has(runStatus),
    items: [],
    ws: null,
    currentAssistant: null,
    currentStep: null,
    lastTool: null,
    pendingPrUrl: typeof status.prUrl === "string" ? status.prUrl : undefined,
    pendingIssueUrl: typeof status.issueUrl === "string" ? status.issueUrl : undefined,
    stepStartedAt: typeof status.stepStartedAt === "number" ? status.stepStartedAt : undefined,
    finishedAt: typeof status.finishedAt === "number" ? status.finishedAt : undefined,
  };
}

/** #runs/<id>: load the status, build the view and let the event replay fill in the rest. */
async function openRun(id: string): Promise<void> {
  const seq = ++openRunSeq;
  closeRun();
  runsViewEl?.replaceChildren(el("div", { class: "card" }, el("p", { class: "cell-muted" }, "Loading run\u2026")));
  let status: Record<string, unknown> | null = null;
  let missing = false;
  try {
    const res = await api(`/status/${encodeURIComponent(id)}`);
    if (res.status === 404) missing = true;
    else if (!res.ok) throw new Error(`status ${res.status}`);
    else status = (await res.json()) as Record<string, unknown>;
  } catch {
    status = null;
  }
  if (seq !== openRunSeq || runsViewTarget !== id) return;
  if (missing) {
    runsViewTarget = `gone:${id}`;
    showRunMessage("This run is gone (the server restarted or it expired).");
    syncHeaderBee();
    return;
  }
  if (!status) {
    showRunMessage("Couldn't load this run.");
    return;
  }
  run = runStateFromStatus(status);
  runUi = null;
  runsViewEl?.replaceChildren(buildRunView());
  renderRunsList(true);
  syncHeaderBee();
  void connect();
}

/** The message shown in place of a run that cannot be opened, with a way back to the form. */
function showRunMessage(message: string): void {
  const newBtn = el("button", { class: "btn btn-primary", type: "button" }, "New run");
  newBtn.onclick = () => {
    location.hash = "#runs";
  };
  runsViewEl?.replaceChildren(el("div", { class: "card runs-message" }, el("p", {}, message), newBtn));
}

function route(): void {
  if (!mainEl || !navRunsEl || !navSettingsEl) return;
  stopUsagePolling();
  const view = location.hash.startsWith("#settings") ? "settings" : "runs";
  if (view === "settings") {
    navSettingsEl.setAttribute("aria-current", "page");
    navRunsEl.removeAttribute("aria-current");
    stopRunsPolling();
    if (runsEl) {
      // The run keeps going on the server; drop the socket and rebuild when it is reopened.
      openRunSeq++;
      closeRun();
      runsViewTarget = null;
    }
    // Rebuilt each time: the sub-page follows the hash and "This computer" reloads its checks.
    settingsEl = buildSettings(location.hash === "#settings/computer" ? "computer" : "keys");
    mainEl.replaceChildren(settingsEl);
    syncHeaderBee();
    return;
  }

  navRunsEl.setAttribute("aria-current", "page");
  navSettingsEl.removeAttribute("aria-current");
  const page = runsPage();
  if (mainEl.firstChild !== page) mainEl.replaceChildren(page);
  startRunsPolling();
  renderRunsList(true);

  const id = location.hash.startsWith("#runs/") ? decodeURIComponent(location.hash.slice("#runs/".length)) : null;
  const target = id ?? "#runs";
  if (target !== runsViewTarget) {
    runsViewTarget = target;
    if (!id) {
      openRunSeq++;
      closeRun();
      runsViewEl?.replaceChildren(buildForm());
    } else if (run?.sessionId !== id) {
      void openRun(id);
    }
  }
  syncHeaderBee();
}

// ── run list: GET /runs while the page is open ──

function startRunsPolling(): void {
  if (runsPollTimer !== undefined) return;
  void refreshRuns();
  runsPollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshRuns();
  }, RUNS_POLL_MS);
}

function stopRunsPolling(): void {
  if (runsPollTimer === undefined) return;
  window.clearInterval(runsPollTimer);
  runsPollTimer = undefined;
}

async function refreshRuns(): Promise<void> {
  const seq = ++runsFetchSeq;
  try {
    const res = await api("/runs");
    if (!res.ok) return;
    const data = (await res.json()) as { runs?: unknown };
    if (seq !== runsFetchSeq) return;
    const parsed: RunSummary[] = [];
    if (Array.isArray(data.runs)) {
      for (const raw of data.runs) {
        const summary = parseRunSummary(raw);
        if (summary) parsed.push(summary);
      }
    }
    parsed.sort((a, b) => b.createdAt - a.createdAt);
    runList = parsed;
    renderRunsList();
    syncHeaderBee();
  } catch {
    // Keep the previous list; the next poll tries again.
  }
}

function runItemElement(summary: RunSummary, index: number): HTMLElement {
  const selected = run?.sessionId === summary.sessionId;
  const item = el("a", { class: "run-item", href: `#runs/${encodeURIComponent(summary.sessionId)}` });
  if (selected) item.setAttribute("aria-current", "page");
  if (index >= MAX_VISIBLE_RUNS) item.classList.add("run-item-extra");
  const status = summary.status;
  const pill = el(
    "span",
    { class: `pill ${STATUS_PILL[status] ?? "pill-muted"}` },
    STATUS_LABEL[status] ?? status,
  );
  const top = el(
    "span",
    { class: "run-item-top" },
    el("span", { class: "run-item-icon" }, miniHive(BEE_STATE[status]?.state ?? "idle")),
    el("span", { class: "run-item-title" }, summary.title || "Untitled run"),
  );
  const meta = el(
    "span",
    { class: "run-item-meta" },
    `${repoLabel(summary.repo, summary.newRepo)} \u00b7 ${summary.model || "default model"} \u00b7 ${runTimeLabel(summary)}`,
  );
  item.append(top, meta, pill);
  return item;
}

function renderRunsList(force = false): void {
  if (!runsListEl) return;
  const signature = JSON.stringify(runList ?? []);
  if (!force && signature === runListSignature) return;
  runListSignature = signature;
  const list = runList ?? [];
  const newBtn = el("button", { id: "newRunBtn", class: "btn btn-primary", type: "button" }, "New run");
  newBtn.onclick = () => {
    location.hash = "#runs";
  };
  const children: HTMLElement[] = [newBtn];
  if (list.length === 0) {
    children.push(el("p", { class: "runs-list-empty" }, "No runs yet. Give the bees a task."));
  } else {
    list.forEach((summary, index) => children.push(runItemElement(summary, index)));
    if (list.length > MAX_VISIBLE_RUNS) {
      const toggle = el(
        "button",
        { class: "btn btn-small text-btn runs-list-toggle", type: "button" },
        runsExpanded ? "Show fewer" : `Show all (${list.length})`,
      );
      toggle.onclick = () => {
        runsExpanded = !runsExpanded;
        runsListEl?.classList.toggle("is-expanded", runsExpanded);
        renderRunsList(true);
      };
      children.push(toggle);
    } else {
      runsExpanded = false;
    }
  }
  runsListEl.classList.toggle("is-expanded", runsExpanded);
  runsListEl.replaceChildren(...children);
  syncHeaderBee();
}

window.addEventListener("hashchange", route);

// ── new-run form ──

let modelRequestSeq = 0;

async function loadModels(providerId: string, input: HTMLInputElement, list: HTMLDataListElement): Promise<void> {
  const seq = ++modelRequestSeq;
  input.value = "";
  list.replaceChildren();
  const entry = providers?.providers.find((p) => p.id === providerId);
  input.placeholder = entry?.model ?? "model ID";
  if (!providerId) return;
  try {
    const res = await api(`/api/models?provider=${encodeURIComponent(providerId)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { models?: string[] };
    if (seq !== modelRequestSeq) return;
    list.replaceChildren();
    for (const id of data.models ?? []) {
      if (typeof id === "string") list.append(el("option", { value: id }));
    }
  } catch {
    // Leave the datalist empty; the user can still type a model ID.
  }
}

function buildForm(): HTMLElement {
  const wrap = el("div");

  const heading = el(
    "div",
    { class: "form-head" },
    el("h1", { id: "new-run-title" }, "New run"),
    el("p", {}, "Give the bees a task. They work on a copy of your repo inside a throwaway microVM."),
  );

  const task = el("textarea", { id: "task", rows: "5", placeholder: "Describe what the agent should do" });
  const taskField = el("div", { class: "field" }, el("label", { for: "task" }, "Task"), task);

  const modeExisting = el("input", {
    id: "mode-existing",
    type: "radio",
    name: "projectMode",
    value: "existing",
    checked: "",
  });
  const modeNew = el("input", { id: "mode-new", type: "radio", name: "projectMode", value: "new" });
  const modeExistingLabel = el(
    "label",
    { class: "segmented-option", for: "mode-existing" },
    modeExisting,
    "Existing repo",
  );
  const modeNewLabel = el("label", { class: "segmented-option", for: "mode-new" }, modeNew, "New project");
  const modeField = el(
    "fieldset",
    { class: "field project-mode" },
    el("legend", {}, "Project"),
    el("div", { class: "segmented" }, modeExistingLabel, modeNewLabel),
  );

  const repo = el("input", {
    id: "repo",
    type: "text",
    list: "repoOptions",
    placeholder: "owner/name, or leave empty",
    autocomplete: "off",
  });
  const repoOptions = el("datalist", { id: "repoOptions" });
  const repoField = el(
    "div",
    { class: "field" },
    el("label", { for: "repo" }, "Repository"),
    repo,
    repoOptions,
  );
  const branch = el("input", {
    id: "branch",
    type: "text",
    list: "branchOptions",
    placeholder: "default branch",
    autocomplete: "off",
  });
  const branchOptions = el("datalist", { id: "branchOptions" });
  const branchField = el(
    "div",
    { class: "field" },
    el("label", { for: "branch" }, "Branch"),
    branch,
    branchOptions,
  );
  const repoRow = el("div", { class: "grid-2" }, repoField, branchField);

  const newRepoName = el("input", {
    id: "newRepoName",
    type: "text",
    placeholder: "my-new-project",
    autocomplete: "off",
  });
  const newRepoError = el("p", { id: "newRepoError", class: "field-error", role: "alert", hidden: "" });
  const newRepoPrivate = el("input", { id: "newRepoPrivate", type: "checkbox", checked: "" });
  const newRepoGroup = el(
    "div",
    { class: "new-repo-fields", hidden: "" },
    el(
      "div",
      { class: "field" },
      el("label", { for: "newRepoName" }, "Project name"),
      newRepoName,
      newRepoError,
      el(
        "label",
        { class: "check-field", for: "newRepoPrivate" },
        newRepoPrivate,
        el("span", {}, "Private repository"),
      ),
      el(
        "p",
        { class: "field-hint" },
        "When the run finishes, hive creates the repository on GitHub under your account and pushes the agent's work to main.",
      ),
    ),
  );

  const provider = el("select", { id: "provider" });
  const providerField = el("div", { class: "field" }, el("label", { for: "provider" }, "Provider"), provider);

  const model = el("input", {
    id: "model",
    type: "text",
    list: "modelOptions",
    placeholder: "model ID",
    autocomplete: "off",
  });
  const modelOptions = el("datalist", { id: "modelOptions" });
  const modelField = el(
    "div",
    { class: "field" },
    el("label", { for: "model" }, "Model"),
    model,
    modelOptions,
    el("p", { class: "field-hint" }, "Pick from the list or type any model ID. Empty uses the default."),
  );

  const thinking = el("select", { id: "thinking" });
  const defaultThinking = providers?.default.thinking;
  thinking.append(
    el("option", { value: "" }, defaultThinking ? `Default (${defaultThinking})` : "Default"),
    ...THINKING_LEVELS.map((level) => el("option", { value: level }, level)),
  );
  const thinkingField = el("div", { class: "field" }, el("label", { for: "thinking" }, "Thinking"), thinking);

  const review = el("select", { id: "review" });
  review.append(
    el("option", { value: "0" }, "No review"),
    el("option", { value: "1" }, "1 review cycle"),
    el("option", { value: "2" }, "2 review cycles"),
  );
  const reviewField = el("div", { class: "field" }, el("label", { for: "review" }, "Review"), review);

  // Reviewer model: same provider as the run, picked from the same model list (shared datalist).
  const reviewModel = el("input", {
    id: "reviewModel",
    type: "text",
    list: "modelOptions",
    placeholder: "same as the main model",
    autocomplete: "off",
  });
  const reviewModelField = el(
    "div",
    { class: "field", id: "reviewModelField", hidden: "" },
    el("label", { for: "reviewModel" }, "Reviewer model"),
    reviewModel,
    el(
      "p",
      { class: "field-hint" },
      "A fresh agent checks the changes and fixes real problems before anything is pushed. Empty uses the main model.",
    ),
  );
  const syncReviewModel = () => {
    reviewModelField.hidden = Number(review.value) === 0;
  };
  review.addEventListener("change", syncReviewModel);

  const optionsGrid = el("div", { class: "grid-2" }, providerField, modelField, thinkingField, reviewField);

  const warnSlot = el("div");
  const alertSlot = el("div", { role: "alert" });
  const startBtn = el("button", { id: "startBtn", class: "btn btn-primary", type: "submit" }, "Start run");

  const keysMissing = !!providers && providers.providers.length > 0 && !providers.providers.some((p) => p.hasKey);
  if (providersFailed) {
    warnSlot.append(el("p", { class: "alert alert-warn" }, "Couldn't load providers"));
  }
  if (keysMissing) {
    warnSlot.append(el("p", { class: "alert alert-warn" }, "Add an API key first (see Settings)"));
  }

  const form = el(
    "form",
    { class: "card", novalidate: "" },
    heading,
    el("div", { class: "form-rows" }, taskField, modeField, repoRow, newRepoGroup, optionsGrid, reviewModelField),
    el("div", { class: "form-actions" }, warnSlot, alertSlot, startBtn),
  );

  const showError = (message: string) => {
    alertSlot.replaceChildren(el("p", { class: "alert alert-danger" }, message));
  };

  const refreshStartState = () => {
    const isNewProject = modeNew.checked;
    const name = newRepoName.value.trim();
    const nameInvalid = isNewProject && !validRepoName(name);
    newRepoError.hidden = !(nameInvalid && name !== "");
    newRepoError.textContent = newRepoError.hidden
      ? ""
      : "Project name may only use letters, digits, '-', '_' and '.' (max 100)";
    startBtn.disabled = keysMissing || nameInvalid;
  };

  const updateMode = () => {
    const isNewProject = modeNew.checked;
    modeExistingLabel.classList.toggle("is-selected", !isNewProject);
    modeNewLabel.classList.toggle("is-selected", isNewProject);
    repoRow.hidden = isNewProject;
    newRepoGroup.hidden = !isNewProject;
    refreshStartState();
  };
  modeExisting.addEventListener("change", updateMode);
  modeNew.addEventListener("change", updateMode);
  newRepoName.addEventListener("input", refreshStartState);
  updateMode();

  const start = async () => {
    if (startBtn.disabled) return;
    alertSlot.replaceChildren();
    const prompt = task.value.trim();
    if (!prompt) {
      showError("Describe what the agent should do first.");
      return;
    }
    const isNewProject = modeNew.checked;
    const repoValue = repo.value.trim();
    const branchValue = branch.value.trim();
    const reviewCycles = Number(review.value);

    const body: Record<string, unknown> = { prompt };
    if (isNewProject) {
      body.newRepo = { name: newRepoName.value.trim(), private: newRepoPrivate.checked };
      if (reviewCycles > 0) body.reviewCycles = reviewCycles;
    } else {
      if (repoValue) body.repo = repoValue;
      if (repoValue && branchValue) body.branch = branchValue;
      if (repoValue && reviewCycles > 0) body.reviewCycles = reviewCycles;
    }
    const reviewModelValue = reviewModel.value.trim();
    if (body.reviewCycles && reviewModelValue) body.reviewModel = reviewModelValue;
    if (provider.value) body.provider = provider.value;
    const modelValue = model.value.trim();
    if (modelValue) body.model = modelValue;
    if (thinking.value) body.thinkingLevel = thinking.value;

    startBtn.disabled = true;
    try {
      const res = await api("/prompt", { method: "POST", body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
      choices = { provider: provider.value, model: modelValue, thinking: thinking.value };
      startRun(data, prompt);
    } catch (err) {
      showError((err as Error).message);
      refreshStartState();
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void start();
  });
  task.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void start();
    }
  });

  // Provider list and preselection.
  provider.replaceChildren();
  if (!providers || providers.providers.length === 0) {
    provider.disabled = true;
  } else {
    for (const entry of providers.providers) {
      const option = el("option", { value: entry.id }, entry.hasKey ? entry.label : `${entry.label} (no key)`);
      option.disabled = !entry.hasKey;
      provider.append(option);
    }
    const wanted = choices.provider || providers.default.provider;
    if (wanted && providers.providers.some((p) => p.id === wanted && p.hasKey)) provider.value = wanted;
    else {
      const firstWithKey = providers.providers.find((p) => p.hasKey);
      if (firstWithKey) provider.value = firstWithKey.id;
    }
    provider.addEventListener("change", () => {
      reviewModel.value = "";
      void loadModels(provider.value, model, modelOptions);
    });
  }
  if (choices.thinking) thinking.value = choices.thinking;

  // Model list for the current provider; restore the remembered model after clearing the input.
  void loadModels(provider.value, model, modelOptions);
  if (choices.model && provider.value === choices.provider) model.value = choices.model;

  // Repository suggestions; silently empty when `gh` isn't available on the server.
  void (async () => {
    try {
      const res = await api("/api/github/repos");
      if (!res.ok) return;
      const repos = (await res.json()) as unknown;
      if (!Array.isArray(repos)) return;
      const options: HTMLOptionElement[] = [];
      for (const entry of repos as Record<string, unknown>[]) {
        const name = entry?.nameWithOwner ?? entry?.fullName ?? entry?.name;
        if (typeof name === "string" && name) options.push(el("option", { value: name }));
      }
      repoOptions.replaceChildren(...options);
    } catch {
      // No suggestions; the field stays free-text.
    }
  })();

  // Branch suggestions for the chosen repo: the default branch becomes the placeholder.
  let branchRequest = 0;
  let branchTimer: number | undefined;
  const loadBranches = async () => {
    const id = ++branchRequest;
    const name = repo.value.trim();
    branchOptions.replaceChildren();
    branch.placeholder = "default branch";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) return;
    try {
      const res = await api(`/api/github/branches?repo=${encodeURIComponent(name)}`);
      if (!res.ok || id !== branchRequest) return;
      const data = (await res.json()) as { defaultBranch?: unknown; branches?: unknown };
      if (id !== branchRequest) return;
      const names = Array.isArray(data.branches) ? data.branches.filter((b): b is string => typeof b === "string") : [];
      branchOptions.replaceChildren(...names.map((b) => el("option", { value: b })));
      if (typeof data.defaultBranch === "string" && data.defaultBranch) {
        branch.placeholder = `${data.defaultBranch} (default)`;
      }
    } catch {
      // No suggestions; the field stays free-text.
    }
  };
  repo.addEventListener("input", () => {
    window.clearTimeout(branchTimer);
    branchTimer = window.setTimeout(() => void loadBranches(), 400);
  });
  repo.addEventListener("change", () => {
    window.clearTimeout(branchTimer);
    void loadBranches();
  });

  wrap.append(form);
  return wrap;
}

// ── run view ──

function startRun(data: Record<string, unknown>, prompt: string): void {
  const providerId = typeof data.provider === "string" ? data.provider : "";
  const label = providers?.providers.find((p) => p.id === providerId)?.label ?? providerId;
  run = {
    sessionId: String(data.sessionId ?? ""),
    repo: typeof data.repo === "string" && data.repo ? data.repo : null,
    newRepo: typeof data.newRepo === "string" && data.newRepo ? data.newRepo : null,
    providerLabel: label,
    model: typeof data.model === "string" ? data.model : "",
    title: firstLine(prompt),
    status: "queued",
    busy: true,
    items: [],
    ws: null,
    currentAssistant: null,
    currentStep: null,
    lastTool: null,
    stepStartedAt: typeof data.stepStartedAt === "number" ? data.stepStartedAt : undefined,
    finishedAt: typeof data.finishedAt === "number" ? data.finishedAt : undefined,
  };
  runUi = null;
  runsViewTarget = run.sessionId;
  runsViewEl?.replaceChildren(buildRunView());
  const id = run.sessionId;
  if (id && location.hash !== `#runs/${encodeURIComponent(id)}`) location.hash = `#runs/${encodeURIComponent(id)}`;
  // Show the new run in the list and the header bee right away.
  void refreshRuns();
  void connect();
}

function fillItem(li: HTMLElement, item: RunItem): void {
  switch (item.kind) {
    case "status":
      li.textContent = item.text;
      if (item.step) li.dataset.step = item.step;
      else delete li.dataset.step;
      break;
    case "user":
      li.textContent = item.text;
      break;
    case "assistant":
      li.innerHTML = formatContent(item.text);
      break;
    case "tool": {
      const children: HTMLElement[] = [el("span", { class: "tool-name" }, item.name)];
      if (item.detail) children.push(el("span", { class: "tool-detail" }, item.detail));
      if (item.failed) children.push(el("span", { class: "tool-failed" }, "failed"));
      li.replaceChildren(...children);
      break;
    }
    case "banner": {
      const children: HTMLElement[] = [el("span", { class: "banner-title" }, item.title)];
      if (item.detail) children.push(el("span", { class: "banner-detail" }, item.detail));
      if (item.link) {
        children.push(
          el(
            "a",
            { class: "banner-link", href: item.link.href, target: "_blank", rel: "noopener noreferrer" },
            item.link.label,
          ),
        );
      }
      const banner = el("div", { class: `item-banner item-banner-${item.tone}` }, ...children);
      if (item.changes) banner.append(changesElement(item.changes));
      if (item.pr) banner.append(prElement(item));
      if (item.issue) banner.append(issueElement(item));
      li.replaceChildren(banner);
      break;
    }
  }
}

function itemElement(item: RunItem): HTMLElement {
  const className =
    item.kind === "tool"
      ? "item-tool"
      : item.kind === "banner"
        ? `item-banner-${item.tone}`
        : `item-${item.kind}`;
  const li = el("li", { class: className });
  fillItem(li, item);
  return li;
}

function buildRunView(): HTMLElement {
  const state = run!;
  runUi?.bee.destroy();
  const pill = el("span", { class: "pill" });
  const stopBtn = el("button", { class: "btn btn-danger", type: "button" }, "Stop");
  stopBtn.onclick = () => void abortRun();
  const newBtn = el("button", { class: "btn", type: "button" }, "New run");
  newBtn.onclick = () => newRun();
  const toolbar = el("div", { class: "run-toolbar" }, pill, el("span", { class: "spacer" }), stopBtn, newBtn);

  // github.com URLs read better as owner/name.
  const repoText = repoLabel(state.repo, state.newRepo);
  const modelText = state.model || "default model";
  const bee = createBeeIndicator();
  const head = el(
    "section",
    { class: "card" },
    el(
      "div",
      { class: "run-head" },
      el("h1", { class: "run-title", title: state.title }, state.title),
      el("p", { class: "run-meta" }, `${repoText} · ${state.providerLabel || "provider"} · ${modelText}`),
      bee.root,
      toolbar,
    ),
  );

  const timeline = el("ol", { class: "timeline" });
  const nodes = new Map<RunItem, HTMLElement>();
  for (const item of state.items) {
    const li = itemElement(item);
    nodes.set(item, li);
    timeline.append(li);
  }
  let empty: HTMLElement | null = null;
  if (state.items.length === 0) {
    empty = el("li", { class: "item-status empty-timeline" }, "The bee is warming up…");
    timeline.append(empty);
  }
  const timelineCard = el("section", { class: "card timeline-card", "aria-label": "Run timeline" }, timeline);

  const followInput = el("textarea", { rows: "2", placeholder: "Send a follow-up to the agent", "aria-label": "Follow-up message" });
  const followBtn = el("button", { class: "btn btn-primary", type: "button" }, "Send");
  followBtn.onclick = () => void sendFollowUp();
  followInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendFollowUp();
    }
  });
  const followUp = el("div", { class: "follow-up" }, followInput, followBtn);

  runUi = { pill, stopBtn, newBtn, timeline, nodes, followInput, followBtn, empty, bee };
  syncRunUi();
  return el("div", {}, head, timelineCard, followUp);
}

/** How many runs reported by GET /runs (plus one just started) are busy. */
function busyRunCount(): number {
  const list = runList ?? [];
  const ids = new Set(list.map((summary) => summary.sessionId));
  let count = list.filter((summary) => BUSY_STATUS.has(summary.status)).length;
  if (run?.busy && !ids.has(run.sessionId)) count++;
  return count;
}

function syncHeaderBee(): void {
  if (!navRunsEl) return;
  const count = busyRunCount();
  if (count > 0) {
    if (!headerBeeEl) {
      headerBeeEl = headerBee();
      navRunsEl.append(headerBeeEl);
    }
    const text = `${count} run${count === 1 ? "" : "s"} in progress`;
    headerBeeEl.title = text;
    const sr = headerBeeEl.querySelector(".sr-only");
    if (sr) sr.textContent = text;
  } else if (headerBeeEl) {
    headerBeeEl.remove();
    headerBeeEl = null;
  }
}

function syncRunUi(): void {
  if (!run || !runUi) return;
  runUi.pill.textContent = STATUS_LABEL[run.status] ?? run.status;
  runUi.pill.className = `pill ${STATUS_PILL[run.status] ?? "pill-muted"}`;
  runUi.stopBtn.hidden = !run.busy;
  runUi.followInput.disabled = run.busy;
  runUi.followBtn.disabled = run.busy;
  const beeState = BEE_STATE[run.status];
  runUi.bee.set(beeState.state, beeState.label, {
    startedAt: run.stepStartedAt,
    endedAt: run.finishedAt,
  });
  syncHeaderBee();
}

function appendItem(item: RunItem): void {
  if (!run) return;
  run.items.push(item);
  if (!runUi) return;
  if (runUi.empty) {
    runUi.empty.remove();
    runUi.empty = null;
  }
  const li = itemElement(item);
  runUi.nodes.set(item, li);
  const stick = nearBottom();
  runUi.timeline.append(li);
  if (stick) scrollToBottom();
}

function updateItem(item: RunItem): void {
  const li = runUi?.nodes.get(item);
  if (!li) return;
  const stick = nearBottom();
  fillItem(li, item);
  if (stick) scrollToBottom();
}

function removeItem(item: RunItem): void {
  if (!run) return;
  const index = run.items.indexOf(item);
  if (index >= 0) run.items.splice(index, 1);
  runUi?.nodes.get(item)?.remove();
  runUi?.nodes.delete(item);
}

function setRunStatus(status: Status): void {
  if (!run) return;
  run.status = status;
  run.busy = BUSY_STATUS.has(status);
  syncRunUi();
}

function handleEvent(event: any): void {
  if (!run) return;
  switch (event.type) {
    case "hive_status": {
      const status = String(event.status ?? "");
      if (status in STATUS_LABEL) setRunStatus(status as Status);
      let text = "";
      if (status === "queued") text = `Queued (${event.running ?? "?"}/${event.max ?? "?"} worker bees busy)`;
      else if (status === "cloning") text = event.newProject ? "Setting up the new project" : "Cloning the repo";
      else if (status === "running") text = "Agent working in the VM";
      else if (status === "reviewing") text = `Review cycle ${event.cycle ?? "?"} of ${event.of ?? "?"}`;
      else if (status === "pushing") text = "Pushing changes";
      if (text) {
        // The previous step is finished once the next one starts.
        if (run.currentStep) {
          run.currentStep.step = "done";
          updateItem(run.currentStep);
        }
        const step: StatusItem = { kind: "status", text, step: "current" };
        run.currentStep = step;
        appendItem(step);
      }
      if (status === "cloning" && event.newProject) runUi?.bee.set("working", "Setting up the new project");
      break;
    }
    case "message_start":
      if (event.message?.role === "assistant") {
        const item: AssistantItem = { kind: "assistant", text: "" };
        run.currentAssistant = item;
        appendItem(item);
      }
      break;
    case "message_update":
      if (run.currentAssistant && event.assistantMessageEvent?.type === "text_delta") {
        run.currentAssistant.text += String(event.assistantMessageEvent.delta ?? "");
        updateItem(run.currentAssistant);
      }
      break;
    case "message_end":
      if (run.currentAssistant) {
        // A replayed run has no message_update events, so take the final text from message_end.
        if (!run.currentAssistant.text) {
          const content = Array.isArray(event.message?.content) ? event.message.content : [];
          const text = content
            .filter((block: any) => block?.type === "text" && typeof block.text === "string")
            .map((block: any) => block.text)
            .join("");
          if (text) {
            run.currentAssistant.text = text;
            updateItem(run.currentAssistant);
          }
        }
        if (!run.currentAssistant.text) removeItem(run.currentAssistant);
        run.currentAssistant = null;
      }
      break;
    case "tool_execution_start": {
      const args = event.args ?? {};
      const detail = String(args.command ?? args.path ?? args.file_path ?? "").slice(0, 200);
      const item: ToolItem = { kind: "tool", name: String(event.toolName ?? "tool"), detail, failed: false };
      run.lastTool = item;
      appendItem(item);
      break;
    }
    case "tool_execution_end":
      if (event.isError && run.lastTool) {
        run.lastTool.failed = true;
        updateItem(run.lastTool);
        run.lastTool = null;
      }
      break;
    case "hive_done":
      if (typeof event.stepStartedAt === "number") run.stepStartedAt = event.stepStartedAt;
      if (typeof event.finishedAt === "number") run.finishedAt = event.finishedAt;
      finishRun(event);
      break;
  }
}

function finishRun(event: any): void {
  if (!run) return;
  const status = String(event.status ?? "");
  if (run.currentStep) {
    run.currentStep.step = status === "idle" ? "done" : "failed";
    updateItem(run.currentStep);
    run.currentStep = null;
  }
  let item: RunItem;
  if (status === "idle") {
    const parts: string[] = [];
    let link: { href: string; label: string } | undefined;
    const createdRepo = typeof event.createdRepo === "string" && event.createdRepo ? event.createdRepo : "";
    if (createdRepo) {
      parts.push(`Created ${createdRepo} with ${event.commitsPushed ?? 0} commit(s)`);
      if (/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(createdRepo)) {
        link = { href: `https://github.com/${createdRepo}`, label: "Open on GitHub" };
      }
    } else if (run.newRepo && Number(event.commitsPushed ?? 0) === 0) {
      parts.push("No changes, so no repository was created");
    } else if (event.resultBranch) {
      parts.push(`Pushed ${event.commitsPushed ?? 0} commit(s) to ${event.resultBranch}`);
      const slug = typeof event.repoSlug === "string" ? event.repoSlug : "";
      const branch = String(event.resultBranch);
      if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) && /^[A-Za-z0-9._\/-]+$/.test(branch)) {
        const encoded = branch.split("/").map(encodeURIComponent).join("/");
        link = { href: `https://github.com/${slug}/compare/${encoded}`, label: "See the changes on GitHub" };
      }
    } else if (!run.newRepo && run.repo) {
      parts.push("No changes were made");
    }
    const cost = Number(event.usage?.cost);
    if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
    const canPr = !createdRepo && !!event.resultBranch && typeof event.repoSlug === "string" && !!event.repoSlug;
    const wroteSomething = run.items.some((i) => i.kind === "assistant" && i.text.trim() !== "");
    const canIssue =
      !run.newRepo &&
      !event.resultBranch &&
      Number(event.commitsPushed ?? 0) === 0 &&
      typeof event.repoSlug === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(event.repoSlug) &&
      wroteSomething;
    item = {
      kind: "banner",
      tone: "ok",
      title: "Done",
      detail: parts.join(" · "),
      link,
      changes: parseChanges(event.changes),
      pr: canPr ? { state: "ready" } : undefined,
      issue: canIssue ? { state: "ready" } : undefined,
    };
  } else if (status === "aborted") {
    item = { kind: "banner", tone: "warn", title: "Stopped", detail: event.error ? String(event.error) : "" };
  } else {
    item = { kind: "banner", tone: "danger", title: "Failed", detail: event.error ? String(event.error) : "" };
  }
  // A reopened run: the replayed hive_done carries no PR/issue URL, so use the saved status.
  if (item.kind === "banner") {
    const prUrl = run.pendingPrUrl;
    const issueUrl = run.pendingIssueUrl;
    run.pendingPrUrl = undefined;
    run.pendingIssueUrl = undefined;
    if (item.tone === "ok") {
      if (prUrl && PR_URL.test(prUrl)) item.pr = { state: "open", url: prUrl };
      if (issueUrl && ISSUE_URL.test(issueUrl)) item.issue = { state: "open", url: issueUrl };
    }
  }
  appendItem(item);
  setRunStatus(status === "idle" ? "idle" : status === "aborted" ? "aborted" : "failed");
  run.ws?.close();
  run.ws = null;
}

async function connect(): Promise<void> {
  if (!run) return;
  const state = run;
  state.ws?.close();
  try {
    const res = await api(`/events/${state.sessionId}/ticket`, { method: "POST" });
    if (!res.ok) throw new Error("couldn't open the event stream");
    const { ticket } = (await res.json()) as { ticket?: string };
    if (run !== state) return;
    const url = `${serverUrl.replace(/^http/, "ws")}/events/${state.sessionId}?ticket=${encodeURIComponent(ticket ?? "")}`;
    const socket = new WebSocket(url);
    state.ws = socket;
    socket.onmessage = (message) => {
      try {
        handleEvent(JSON.parse(message.data));
      } catch {}
    };
    socket.onclose = () => {
      if (run !== state || !state.busy) return;
      appendItem({ kind: "status", text: "Lost the live stream; the run may still be going." });
      state.busy = false;
      syncRunUi();
    };
  } catch {
    if (run === state) {
      appendItem({ kind: "status", text: "Couldn't open the event stream." });
      state.busy = false;
      syncRunUi();
    }
  }
}

async function abortRun(): Promise<void> {
  if (!run) return;
  try {
    await api(`/abort/${run.sessionId}`, { method: "POST" });
  } catch {}
}

async function sendFollowUp(): Promise<void> {
  if (!run || run.busy || !runUi) return;
  const text = runUi.followInput.value.trim();
  if (!text) return;
  runUi.followInput.value = "";
  appendItem({ kind: "user", text });
  run.busy = true;
  syncRunUi();
  try {
    const res = await api("/prompt", { method: "POST", body: JSON.stringify({ prompt: text, sessionId: run.sessionId }) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
    if (typeof data.stepStartedAt === "number") run.stepStartedAt = data.stepStartedAt;
    run.finishedAt = typeof data.finishedAt === "number" ? data.finishedAt : undefined;
    await connect();
  } catch (err) {
    appendItem({ kind: "banner", tone: "danger", title: "Couldn't send", detail: (err as Error).message });
    run.busy = false;
    syncRunUi();
  }
}

function newRun(): void {
  location.hash = "#runs";
  // If the hash is already #runs there is nothing to rebuild, but the button only shows on a run.
}

// ── settings: API keys ──

type KeyTestStatus = "works" | "refused" | "testing" | "unchecked";

interface KeysProvider {
  id: string;
  label: string;
  hasKey: boolean;
  source: "environment" | "saved" | "env-file" | null;
  masked: string | null;
  defaultModel: string | null;
  isDefault: boolean;
  envName: string;
}

interface KeysResponse {
  file: string;
  defaultProvider: string | null;
  providers: KeysProvider[];
}

interface KeyRowStatus {
  status: KeyTestStatus;
  detail: string;
}

/** Test results for this page; the server keeps no test state of its own. */
const keyStatuses = new Map<string, KeyRowStatus>();

const KEY_STATUS_PILL: Record<Exclude<KeyTestStatus, "testing">, { label: string; cls: string }> = {
  works: { label: "Works", cls: "pill-ok" },
  refused: { label: "Refused", cls: "pill-danger" },
  unchecked: { label: "Unchecked", cls: "pill-warn" },
};

function keyStatusElement(provider: KeysProvider): HTMLElement {
  const status = keyStatuses.get(provider.id);
  if (!status) return el("span", { class: "pill pill-muted" }, "Not tested");
  if (status.status === "testing") return el("span", { class: "pill pill-muted" }, "Testing\u2026");
  const pill = KEY_STATUS_PILL[status.status];
  return el("span", { class: `pill ${pill.cls}`, title: status.detail }, pill.label);
}

function buildKeysPage(): HTMLElement {
  const content = el("section", { class: "settings-content", "aria-labelledby": "settings-title" });
  const addBtn = el("button", { id: "addKeyBtn", class: "btn btn-primary", type: "button" }, "Add key");
  const head = el("div", { class: "settings-head" }, el("h1", { id: "settings-title" }, "API keys"), addBtn);
  const lead = el(
    "p",
    { class: "settings-lead" },
    "A run only gets the key of the provider it uses, passed into its VM for that run.",
  );
  const errorSlot = el("div", { role: "alert" });
  const formSlot = el("div");
  const tableSlot = el("div");
  const storageSlot = el("div");
  content.append(head, lead, errorSlot, formSlot, tableSlot, storageSlot);

  let data: KeysResponse | null = null;
  let failed = false;
  let showForm = false;
  let chosen: string | null = null;
  let pendingRemove: string | null = null;

  const showError = (message: string) => errorSlot.replaceChildren(el("p", { class: "alert alert-danger" }, message));
  const clearError = () => errorSlot.replaceChildren();

  async function fetchData(): Promise<void> {
    failed = false;
    try {
      const res = await api("/api/keys");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      data = (await res.json()) as KeysResponse;
    } catch {
      data = null;
      failed = true;
    }
  }

  const refresh = async (): Promise<void> => {
    // The New run form's provider list and defaults come from /api/providers too.
    await Promise.all([fetchData(), loadProviders()]);
    renderAll();
  };

  function renderStorage(): void {
    const file = data?.file ?? "~/.config/agent-hive/env";
    storageSlot.replaceChildren(
      el(
        "div",
        { class: "card keys-storage" },
        el("h2", {}, "Where keys are kept"),
        el(
          "p",
          {},
          "Saved keys live in ",
          el("code", {}, file),
          ", readable only by you. An exported variable such as ",
          el("code", {}, "OPENROUTER_API_KEY"),
          " wins over a saved key.",
        ),
        el(
          "pre",
          { class: "code-block" },
          "hive keys list\nhive keys add deepseek\nhive keys test\nhive keys default openrouter\nhive keys remove openai",
        ),
      ),
    );
  }

  async function runTest(provider: KeysProvider): Promise<void> {
    clearError();
    keyStatuses.set(provider.id, { status: "testing", detail: "" });
    renderTable();
    try {
      const res = await api(`/api/keys/${encodeURIComponent(provider.id)}/test`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
      const status =
        body.status === "works" || body.status === "refused" || body.status === "unchecked" ? body.status : "unchecked";
      keyStatuses.set(provider.id, { status, detail: typeof body.detail === "string" ? body.detail : "" });
    } catch (err) {
      keyStatuses.set(provider.id, { status: "unchecked", detail: err instanceof Error ? err.message : String(err) });
    }
    renderTable();
  }

  async function makeDefault(provider: KeysProvider): Promise<void> {
    clearError();
    try {
      const res = await api("/api/keys/default", { method: "PUT", body: JSON.stringify({ provider: provider.id }) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
      await refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeKey(provider: KeysProvider): Promise<void> {
    clearError();
    try {
      const res = await api(`/api/keys/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
      pendingRemove = null;
      keyStatuses.delete(provider.id);
      await refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveKey(providerId: string, value: string, saveBtn: HTMLButtonElement): Promise<void> {
    clearError();
    saveBtn.disabled = true;
    try {
      const res = await api("/api/keys", { method: "POST", body: JSON.stringify({ provider: providerId, key: value }) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
      const status =
        body.status === "works" || body.status === "refused" || body.status === "unchecked" ? body.status : "unchecked";
      keyStatuses.set(providerId, { status, detail: typeof body.detail === "string" ? body.detail : "" });
      showForm = false;
      chosen = null;
      await refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      saveBtn.disabled = false;
    }
  }

  function renderForm(): void {
    formSlot.replaceChildren();
    if (!showForm || !data) return;
    const candidates = data.providers.filter((p) => !p.hasKey);
    if (candidates.length === 0) {
      showForm = false;
      return;
    }
    if (!chosen || !candidates.some((p) => p.id === chosen)) chosen = candidates[0].id;
    let selected = candidates.find((p) => p.id === chosen)!;

    const chips = el("div", { class: "key-chips", role: "radiogroup", "aria-label": "Provider" });
    const labelFor = el("label", { for: "newKey" }, `${selected.label} API key`);
    const keyInput = el("input", {
      id: "newKey",
      type: "password",
      autocomplete: "off",
      "aria-label": `${selected.label} API key`,
    });
    const saveBtn = el("button", { id: "saveKeyBtn", class: "btn btn-primary", type: "submit" }, "Test and save");
    saveBtn.disabled = true;
    const cancelBtn = el("button", { id: "cancelKeyBtn", class: "btn", type: "button" }, "Cancel");

    for (const p of candidates) {
      const input = el("input", { type: "radio", name: "keyProvider", value: p.id, "aria-label": p.label });
      input.checked = p.id === selected.id;
      const chip = el("label", { class: `key-chip${p.id === selected.id ? " is-selected" : ""}` }, input, p.label);
      input.addEventListener("change", () => {
        if (!input.checked) return;
        selected = p;
        chosen = p.id;
        for (const node of Array.from(chips.querySelectorAll(".key-chip"))) {
          node.classList.toggle("is-selected", node === chip);
        }
        labelFor.textContent = `${p.label} API key`;
        keyInput.setAttribute("aria-label", `${p.label} API key`);
      });
      chips.append(chip);
    }

    keyInput.addEventListener("input", () => {
      saveBtn.disabled = keyInput.value.length < 8;
    });

    const file = data.file;
    const form = el(
      "form",
      { id: "addKeyForm", class: "card key-add-form", novalidate: "" },
      el("h2", {}, "Add a key"),
      chips,
      el("div", { class: "field" }, labelFor, keyInput),
      el(
        "p",
        { class: "key-form-hint" },
        "Saved to ",
        el("code", {}, file),
        ", readable only by you. hive makes one free request to check the key first.",
      ),
      el("div", { class: "key-form-actions" }, cancelBtn, saveBtn),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (saveBtn.disabled) return;
      void saveKey(selected.id, keyInput.value, saveBtn);
    });
    cancelBtn.onclick = () => {
      showForm = false;
      chosen = null;
      clearError();
      renderForm();
    };
    formSlot.append(form);
    keyInput.focus();
  }

  function providerRow(p: KeysProvider): HTMLElement {
    const keyCell = el("td");
    if (p.hasKey && p.masked) {
      keyCell.append(el("span", { class: "key-masked mono" }, p.masked));
      if (p.source === "environment") {
        keyCell.append(el("div", { class: "cell-note" }, `From the environment (${p.envName})`));
      }
    } else {
      keyCell.append(el("span", { class: "cell-muted" }, "No key"));
    }
    keyCell.append(
      el(
        "div",
        { class: "cell-note" },
        p.defaultModel ? `Default model: ${p.defaultModel}` : "No default model (set one per run)",
      ),
    );

    const statusCell = el("td");
    if (p.hasKey) statusCell.append(keyStatusElement(p));

    let defaultCell: HTMLElement;
    if (p.isDefault) {
      defaultCell = el("td", {}, el("span", { class: "pill pill-accent" }, "Default"));
    } else if (p.hasKey) {
      const button = el(
        "button",
        { class: "text-btn", type: "button", "data-provider": p.id, "data-action": "default" },
        "Make default",
      );
      button.onclick = () => void makeDefault(p);
      defaultCell = el("td", {}, button);
    } else {
      defaultCell = el("td");
    }

    const actionsCell = el("td");
    if (p.hasKey) {
      const testBtn = el(
        "button",
        { class: "btn btn-small", type: "button", "data-provider": p.id, "data-action": "test" },
        "Test",
      );
      testBtn.onclick = () => void runTest(p);
      const removeBtn = el(
        "button",
        { class: "btn btn-small btn-danger", type: "button", "data-provider": p.id, "data-action": "remove" },
        "Remove",
      );
      if (p.source === "environment") {
        removeBtn.disabled = true;
        removeBtn.title = "Set in the server's environment; change it there";
      }
      removeBtn.onclick = () => {
        pendingRemove = p.id;
        renderTable();
      };
      actionsCell.append(el("div", { class: "table-actions" }, testBtn, removeBtn));
    }

    return el(
      "tr",
      {},
      el("td", { class: "provider-name" }, p.label),
      keyCell,
      statusCell,
      defaultCell,
      actionsCell,
    );
  }

  function confirmRow(p: KeysProvider): HTMLElement {
    const keep = el("button", { class: "btn btn-small", type: "button" }, "Keep it");
    keep.onclick = () => {
      pendingRemove = null;
      renderTable();
    };
    const remove = el(
      "button",
      { class: "btn btn-small btn-danger", type: "button", "data-action": "confirm-remove" },
      "Remove key",
    );
    remove.onclick = () => void removeKey(p);
    return el(
      "tr",
      { class: "key-confirm-row" },
      el(
        "td",
        { colspan: "5" },
        el(
          "div",
          { class: "key-confirm" },
          el(
            "p",
            {},
            `Remove the ${p.label} key? Runs that use ${p.label} will stop working until you add one again.`,
          ),
          el("div", { class: "key-form-actions" }, keep, remove),
        ),
      ),
    );
  }

  function renderTable(): void {
    tableSlot.replaceChildren();
    if (!data) {
      tableSlot.append(el("p", { class: "cell-muted" }, failed ? "Couldn't load API keys." : "Loading keys\u2026"));
      return;
    }
    const table = el("table", { id: "keysTable" });
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col" }, "Provider"),
          el("th", { scope: "col" }, "Key and default model"),
          el("th", { scope: "col" }, "Status"),
          el("th", { scope: "col" }, "Default"),
          el("th", { scope: "col" }, "Actions"),
        ),
      ),
    );
    const tbody = el("tbody");
    for (const p of data.providers) {
      tbody.append(providerRow(p));
      if (pendingRemove === p.id) tbody.append(confirmRow(p));
    }
    table.append(tbody);
    tableSlot.append(el("div", { class: "table-wrap" }, table));
  }

  function renderAll(): void {
    addBtn.hidden = data !== null && data.providers.every((p) => p.hasKey);
    renderForm();
    renderTable();
    renderStorage();
  }

  addBtn.onclick = () => {
    showForm = true;
    pendingRemove = null;
    clearError();
    renderForm();
  };

  renderAll();
  void refresh();
  return content;
}

function buildSettings(page: "keys" | "computer"): HTMLElement {
  const apiKeysBtn = el("button", { class: "settings-nav-btn", type: "button" }, "API keys");
  const computerBtn = el("button", { id: "settings-computer", class: "settings-nav-btn", type: "button" }, "This computer");
  (page === "keys" ? apiKeysBtn : computerBtn).setAttribute("aria-current", "page");
  apiKeysBtn.onclick = () => {
    location.hash = "#settings";
  };
  computerBtn.onclick = () => {
    location.hash = "#settings/computer";
  };
  const nav = el("nav", { class: "settings-nav", "aria-label": "Settings" }, apiKeysBtn, computerBtn);
  if (page === "computer") return el("div", { class: "settings-layout" }, nav, buildComputerPage());
  return el("div", { class: "settings-layout" }, nav, buildKeysPage());
}

interface SystemInfo {
  isolation: string;
  runtime: string;
  warning?: string;
  checks: { name: string; ok: boolean; detail: string }[];
  vm: { memory: string; cpus: string; timeoutMin: number };
  capacity: { running: number; queued: number; max: number };
  gitProtocol: string;
  github?: { connected: boolean; login?: string; error?: string };
  npmCache: boolean;
  version: string;
}

const ISOLATION_TEXT: Record<string, string> = {
  microvm: "MicroVM",
  unavailable: "Nothing available",
};

/** One plain sentence on what the runtime is, and where to read more. */
const RUNTIME_ABOUT: Record<string, { text: string; href: string; label: string }> = {
  libkrun: {
    text: "libkrun is a small library that boots a lightweight virtual machine with your CPU's built-in virtualization (KVM). Each run gets its own Linux kernel, so the agent can't touch this computer's files or processes.",
    href: "https://github.com/containers/libkrun",
    label: "What is libkrun?",
  },
};

const RUNTIME_TEXT: Record<string, string> = {
  libkrun: "libkrun, started directly",
};

interface UsageResponse {
  hostname?: string;
  cpu: { percent: number; cores: number; load1: number };
  memory: { usedBytes: number; totalBytes: number };
  disk: { path: string; freeBytes: number; totalBytes: number };
  temperature: { celsius: number; sensor: string } | null;
  runs: { running: number; queued: number; max: number };
}

let usageTimer: number | undefined;

function stopUsagePolling(): void {
  if (usageTimer === undefined) return;
  window.clearInterval(usageTimer);
  usageTimer = undefined;
}

/** "not reported" handling and one-decimal numbers for the usage tiles. */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatGB(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 100 ? String(Math.round(gb)) : gb.toFixed(1);
}

/** One tile: a label, a big value, an optional detail and a bar (0-100, warn/danger marks). */
function usageTile(
  label: string,
  value: string,
  detail: string,
  bar?: { percent: number; warnAt: number; dangerAt: number },
): HTMLElement {
  const tile = el("div", { class: "usage-tile" }, el("span", { class: "usage-label" }, label), el("span", { class: "usage-value" }, value));
  if (detail) tile.append(el("span", { class: "usage-detail" }, detail));
  if (bar) {
    const fill = el("div", { class: "usage-bar-fill" });
    fill.style.width = `${Math.min(100, Math.max(0, bar.percent))}%`;
    if (bar.percent >= bar.dangerAt) fill.classList.add("is-danger");
    else if (bar.percent >= bar.warnAt) fill.classList.add("is-warn");
    tile.append(el("div", { class: "usage-bar", role: "presentation" }, fill));
  }
  return tile;
}

function renderUsage(section: HTMLElement, data: UsageResponse): void {
  const usedMemoryPercent = data.memory.totalBytes > 0 ? (data.memory.usedBytes / data.memory.totalBytes) * 100 : 0;
  const usedDiskPercent = data.disk.totalBytes > 0 ? ((data.disk.totalBytes - data.disk.freeBytes) / data.disk.totalBytes) * 100 : 0;
  const temperature = data.temperature;
  const tiles = [
    usageTile("CPU", `${formatNumber(data.cpu.percent)}%`, `${data.cpu.cores} core${data.cpu.cores === 1 ? "" : "s"} \u00b7 load ${formatNumber(data.cpu.load1)}`, {
      percent: data.cpu.percent,
      warnAt: 75,
      dangerAt: 90,
    }),
    usageTile("Memory", `${formatGB(data.memory.usedBytes)} GB`, `in use of ${formatGB(data.memory.totalBytes)} GB`, {
      percent: usedMemoryPercent,
      warnAt: 75,
      dangerAt: 90,
    }),
    usageTile("Disk free", `${formatGB(data.disk.freeBytes)} GB`, `free of ${formatGB(data.disk.totalBytes)} GB`, {
      percent: usedDiskPercent,
      warnAt: 75,
      dangerAt: 90,
    }),
    temperature
      ? usageTile("CPU temperature", `${formatNumber(temperature.celsius)} \u00b0C`, temperature.sensor)
      : usageTile("CPU temperature", "Not reported", ""),
    usageTile(
      "Runs",
      `${data.runs.running} of ${data.runs.max}`,
      `running \u00b7 ${data.runs.queued} queued`,
    ),
  ];
  // A temperature has no bar; the value itself turns warn/danger when the CPU runs hot.
  const tempTile = tiles[3];
  if (temperature) {
    const valueEl = tempTile.querySelector(".usage-value");
    if (valueEl) {
      if (temperature.celsius >= 90) valueEl.classList.add("is-danger");
      else if (temperature.celsius >= 80) valueEl.classList.add("is-warn");
    }
  }
  const title = section.querySelector(".usage-title");
  if (title) title.textContent = data.hostname ? `Resources \u00b7 ${data.hostname}` : "Resources";
  const grid = section.querySelector(".usage-grid");
  if (grid) grid.replaceChildren(...tiles);
}

function usageSection(): HTMLElement {
  return el(
    "section",
    { class: "usage-section", id: "usageSection" },
    el("h2", { class: "section-title usage-title" }, "Resources"),
    el("div", { class: "usage-grid" }, el("p", { class: "cell-muted" }, "Loading\u2026")),
  );
}

/** Poll /api/system/usage while the page is open and visible; stop when it leaves the document. */
function startUsagePolling(section: HTMLElement): void {
  stopUsagePolling();
  const tick = async (): Promise<void> => {
    if (!section.isConnected) {
      stopUsagePolling();
      return;
    }
    if (document.visibilityState !== "visible") return;
    try {
      const res = await api("/api/system/usage");
      if (!res.ok) return;
      const data = (await res.json()) as UsageResponse;
      if (section.isConnected) renderUsage(section, data);
    } catch {
      // Keep the last numbers; the next tick tries again.
    }
  };
  void tick();
  usageTimer = window.setInterval(() => void tick(), 5000);
}

/** Settings > This computer: what runs are isolated with, and the checks behind it. */
function buildComputerPage(): HTMLElement {
  const body = el("div", { class: "computer-body" }, el("p", { class: "cell-muted" }, "Checking this computer…"));
  const content = el(
    "section",
    { class: "settings-content", "aria-labelledby": "settings-title" },
    el("h1", { id: "settings-title" }, "This computer"),
    el("p", { class: "settings-lead" }, "What each run is isolated with, and what it may use."),
    body,
  );
  void (async () => {
    try {
      const res = await api("/api/system");
      if (!res.ok) throw new Error(String(res.status));
      body.replaceChildren(...computerSections((await res.json()) as SystemInfo));
      const section = body.querySelector<HTMLElement>("#usageSection");
      if (section) startUsagePolling(section);
    } catch {
      body.replaceChildren(el("p", { class: "alert alert-danger" }, "Couldn't load this computer's setup."));
    }
  })();
  return content;
}

function computerSections(info: SystemInfo): HTMLElement[] {
  const strong = info.isolation === "microvm";
  const summary = el(
    "div",
    { class: `card isolation-card ${strong ? "isolation-ok" : "isolation-warn"}`, id: "isolationCard" },
    el(
      "div",
      { class: "isolation-head" },
      el("span", { class: "isolation-label" }, "Runs are isolated in a"),
      el("span", { class: "isolation-value" }, ISOLATION_TEXT[info.isolation] ?? info.isolation),
      el("span", { class: `pill ${strong ? "pill-ok" : "pill-warn"}` }, strong ? "Strong isolation" : "Weaker isolation"),
    ),
    el("p", { class: "isolation-runtime" }, RUNTIME_TEXT[info.runtime] ?? info.runtime),
  );
  const about = RUNTIME_ABOUT[info.runtime];
  if (about) {
    summary.append(
      el(
        "p",
        { class: "isolation-about", id: "runtimeAbout" },
        about.text + " ",
        el("a", { href: about.href, target: "_blank", rel: "noopener noreferrer" }, about.label),
      ),
    );
  }
  if (info.warning) summary.append(el("p", { class: "alert alert-warn" }, info.warning));

  const table = el("table", { id: "checksTable" });
  table.append(
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Check"), el("th", { scope: "col" }, "Status"), el("th", { scope: "col" }, "Detail"))),
  );
  const tbody = el("tbody");
  for (const check of info.checks) {
    tbody.append(
      el(
        "tr",
        {},
        el("td", { class: "provider-name" }, check.name),
        el("td", {}, el("span", { class: `pill ${check.ok ? "pill-ok" : "pill-danger"}` }, check.ok ? "Ready" : "Missing")),
        el("td", { class: "cell-detail" }, check.detail),
      ),
    );
  }
  table.append(tbody);

  const facts: [string, string][] = [
    ["VM size", `${info.vm.memory} memory, ${info.vm.cpus} CPU${info.vm.cpus === "1" ? "" : "s"}`],
    ["Time limit per run", `${info.vm.timeoutMin} minutes`],
    ["Runs at once (worker bees)", `${info.capacity.running} busy of ${info.capacity.max}, ${info.capacity.queued} queued`],
    ["Shared npm cache", info.npmCache ? "On" : "Off"],
    ["hive version", info.version],
  ];
  const list = el("dl", { class: "facts" });
  for (const [term, value] of facts) list.append(el("div", { class: "fact" }, el("dt", {}, term), el("dd", {}, value)));

  const gh = info.github;
  const ghCard = el(
    "div",
    { class: "card github-card", id: "githubCard" },
    el(
      "div",
      { class: "github-head" },
      el("span", { class: "github-account" }, gh?.connected && gh.login ? gh.login : "Not connected"),
      el("span", { class: `pill ${gh?.connected ? "pill-ok" : "pill-danger"}` }, gh?.connected ? "Connected" : "Not connected"),
    ),
    el(
      "p",
      { class: "github-detail" },
      gh?.connected
        ? `Runs clone and push over ${info.gitProtocol === "ssh" ? "SSH with deploy keys" : "HTTPS with this login"}. Pull requests and new repositories are created as ${gh.login}.`
        : "Run gh auth login on the server so runs can clone private repos, push branches and open pull requests.",
    ),
    el(
      "p",
      { class: "github-detail" },
      el("a", { href: "https://www.githubstatus.com/", target: "_blank", rel: "noopener noreferrer" }, "GitHub service status"),
    ),
  );

  return [summary, el("h2", { class: "section-title" }, "GitHub"), ghCard, el("h2", { class: "section-title" }, "Checks"), el("div", { class: "table-wrap" }, table), usageSection(), el("h2", { class: "section-title" }, "Limits"), el("div", { class: "card" }, list)];
}

// ── theme ──

type Theme = "light" | "dark";
const THEME_KEY = "hive_theme";

/** The saved choice, or null to follow the device. */
function savedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage unavailable: follow the device.
  }
  return null;
}

function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme | null): void {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
}

function themeIcon(theme: Theme): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute(
    "d",
    theme === "light"
      ? "M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z M8 1.5v1.5 M8 13v1.5 M1.5 8H3 M13 8h1.5 M3.4 3.4l1 1 M11.6 11.6l1 1 M3.4 12.6l1-1 M11.6 4.4l1-1"
      : "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z",
  );
  svg.append(path);
  return svg;
}

/** A door with an arrow leaving it, for Log out. */
function logoutIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", "M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3 M10.5 11l3-3-3-3 M13.5 8H6.5");
  svg.append(path);
  return svg;
}

/**
 * Header button switching between light and dark. It shows the theme a click switches to.
 * Until the viewer picks one it follows the device; the pick is kept in this browser.
 */
function themeButton(): HTMLButtonElement {
  const button = el("button", { id: "themeBtn", class: "btn btn-small btn-ghost icon-btn theme-btn", type: "button" });
  const render = () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    button.replaceChildren(themeIcon(next));
    button.setAttribute("aria-label", `Switch to ${next} theme`);
    button.title = `Switch to ${next} theme`;
  };
  button.onclick = () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not remembered, but still applied for this page.
    }
    applyTheme(next);
    render();
  };
  // Following the device: keep the icon right when the device switches.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", render);
  render();
  return button;
}

applyTheme(savedTheme());

// ── boot ──

(async () => {
  takeTokenFromHash();
  if (!getToken()) {
    renderLogin();
    return;
  }
  const user = await validateToken();
  if (!user) {
    clearToken();
    renderLogin(true);
    return;
  }
  await enterApp(user);
})();
