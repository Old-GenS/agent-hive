/// <reference types="vite/client" />
/**
 * hive UI: Runs (new-run form with a per-provider model list, live run timeline, Stop and
 * follow-ups) and Settings (API key status and defaults, read-only for now).
 *
 * Everything from the server, GitHub or the agent is rendered as text, except the output of
 * formatContent(), which escapes first and only then adds a fixed set of formatting tags.
 */
import "./app.css";
import { createBeeIndicator, headerBee, type BeeIndicator, type BeeState } from "./bee.js";
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
  idle: { state: "done", label: "Done" },
  failed: { state: "failed", label: "Failed" },
  aborted: { state: "stopped", label: "Stopped" },
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

type Tone = "ok" | "warn" | "danger";

interface AssistantItem {
  kind: "assistant";
  text: string;
}

interface ToolItem {
  kind: "tool";
  name: string;
  detail: string;
  failed: boolean;
}

type RunItem =
  | { kind: "status"; text: string }
  | { kind: "user"; text: string }
  | AssistantItem
  | ToolItem
  | { kind: "banner"; tone: Tone; title: string; detail: string; link?: { href: string; label: string } };

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
  lastTool: ToolItem | null;
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
let settingsEl: HTMLElement | null = null;
let navRunsEl: HTMLButtonElement | null = null;
let navSettingsEl: HTMLButtonElement | null = null;
let headerBeeEl: HTMLElement | null = null;

let run: RunState | null = null;
let runUi: RunUi | null = null;

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
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
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
  const logout = el("button", { id: "logoutBtn", class: "btn btn-small btn-ghost", type: "button" }, "Log out");
  logout.onclick = () => {
    run?.ws?.close();
    runUi?.bee.destroy();
    run = null;
    runUi = null;
    headerBeeEl = null;
    runsEl = null;
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
      el("div", { class: "header-user" }, el("span", { class: "user-name" }, user.name), logout),
    ),
  );
  mainEl = el("main", { class: "main" });
  $app.replaceChildren(header, mainEl);

  if (!location.hash) history.replaceState(null, "", "#runs");
  route();
}

function route(): void {
  if (!mainEl || !navRunsEl || !navSettingsEl) return;
  const view = location.hash === "#settings" ? "settings" : "runs";
  if (view === "runs") {
    navRunsEl.setAttribute("aria-current", "page");
    navSettingsEl.removeAttribute("aria-current");
    if (!runsEl) {
      runsEl = el("div", { class: "page-narrow" });
      runsEl.append(run ? buildRunView() : buildForm());
    }
    mainEl.replaceChildren(runsEl);
  } else {
    navSettingsEl.setAttribute("aria-current", "page");
    navRunsEl.removeAttribute("aria-current");
    if (!settingsEl) settingsEl = buildSettings();
    mainEl.replaceChildren(settingsEl);
  }
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
    el("p", {}, "The agent works on a copy of the repo inside a throwaway VM."),
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
  const branch = el("input", { id: "branch", type: "text", placeholder: "default branch", autocomplete: "off" });
  const branchField = el("div", { class: "field" }, el("label", { for: "branch" }, "Branch"), branch);
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
    el("div", { class: "form-rows" }, taskField, modeField, repoRow, newRepoGroup, optionsGrid),
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
    lastTool: null,
  };
  runUi = null;
  if (runsEl) runsEl.replaceChildren(buildRunView());
  void connect();
}

function fillItem(li: HTMLElement, item: RunItem): void {
  switch (item.kind) {
    case "status":
      li.textContent = item.text;
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
      li.replaceChildren(el("div", { class: `item-banner item-banner-${item.tone}` }, ...children));
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

  const repoText = state.newRepo ? `new project ${state.newRepo}` : state.repo ?? "no repo";
  const modelText = state.model || "default model";
  const bee = createBeeIndicator();
  const head = el(
    "section",
    { class: "card" },
    el(
      "div",
      { class: "run-head" },
      el("h1", { class: "run-title" }, state.title),
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
    empty = el("li", { class: "item-status empty-timeline" }, "Waiting for the agent to start.");
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

function syncHeaderBee(): void {
  if (!navRunsEl) return;
  if (run?.busy) {
    if (!headerBeeEl) {
      headerBeeEl = headerBee();
      navRunsEl.append(headerBeeEl);
    }
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
  runUi.newBtn.hidden = run.busy;
  runUi.followInput.disabled = run.busy;
  runUi.followBtn.disabled = run.busy;
  const beeState = BEE_STATE[run.status];
  runUi.bee.set(beeState.state, beeState.label);
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
      if (status === "queued") text = `Queued (${event.running ?? "?"}/${event.max ?? "?"} sandboxes busy)`;
      else if (status === "cloning") text = event.newProject ? "Setting up the new project" : "Cloning the repo";
      else if (status === "running") text = "Agent working in the VM";
      else if (status === "reviewing") text = `Review cycle ${event.cycle ?? "?"} of ${event.of ?? "?"}`;
      else if (status === "pushing") text = "Pushing changes";
      if (text) appendItem({ kind: "status", text });
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
      finishRun(event);
      break;
  }
}

function finishRun(event: any): void {
  if (!run) return;
  const status = String(event.status ?? "");
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
    }
    const cost = Number(event.usage?.cost);
    if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
    item = { kind: "banner", tone: "ok", title: "Done", detail: parts.join(" · "), link };
  } else if (status === "aborted") {
    item = { kind: "banner", tone: "warn", title: "Stopped", detail: event.error ? String(event.error) : "" };
  } else {
    item = { kind: "banner", tone: "danger", title: "Failed", detail: event.error ? String(event.error) : "" };
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
    await connect();
  } catch (err) {
    appendItem({ kind: "banner", tone: "danger", title: "Couldn't send", detail: (err as Error).message });
    run.busy = false;
    syncRunUi();
  }
}

function newRun(): void {
  run?.ws?.close();
  runUi?.bee.destroy();
  run = null;
  runUi = null;
  syncHeaderBee();
  if (runsEl) runsEl.replaceChildren(buildForm());
}

// ── settings ──

function buildKeysTable(): HTMLElement {
  const table = el("table", { id: "settingsTable" });
  table.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col" }, "Provider"),
        el("th", { scope: "col" }, "Default model"),
        el("th", { scope: "col" }, "Key"),
        el("th", { scope: "col" }, "Default"),
      ),
    ),
  );
  const tbody = el("tbody");
  const defaultProvider = providers?.default.provider ?? null;
  for (const entry of providers?.providers ?? []) {
    const keyPill = entry.hasKey
      ? el("span", { class: "pill pill-ok" }, "Key set")
      : el("span", { class: "pill pill-muted" }, "No key");
    const modelCell = entry.model
      ? el("span", {}, entry.model)
      : el("span", { class: "cell-muted" }, "none (set one per run)");
    let defaultCell: HTMLElement;
    if (entry.id === defaultProvider) {
      defaultCell = el(
        "div",
        {},
        el("span", { class: "pill pill-accent" }, "Default"),
        el("div", { class: "cell-note" }, providers?.default.providerSource ?? ""),
      );
    } else {
      defaultCell = el("span", { class: "cell-muted" }, "");
    }
    tbody.append(
      el(
        "tr",
        {},
        el("td", { class: "provider-name" }, entry.label),
        el("td", {}, modelCell),
        el("td", {}, keyPill),
        el("td", {}, defaultCell),
      ),
    );
  }
  if (!providers || providers.providers.length === 0) {
    tbody.append(
      el("tr", {}, el("td", { colspan: "4", class: "cell-muted" }, providersFailed ? "Couldn't load providers" : "No providers")),
    );
  }
  table.append(tbody);
  return el("div", { class: "table-wrap" }, table);
}

function buildSettings(): HTMLElement {
  const apiKeysBtn = el("button", { class: "settings-nav-btn", type: "button", "aria-current": "page" }, "API keys");
  const nav = el("nav", { class: "settings-nav", "aria-label": "Settings" }, apiKeysBtn);

  const content = el(
    "section",
    { class: "settings-content", "aria-labelledby": "settings-title" },
    el("h1", { id: "settings-title" }, "API keys"),
    el("p", { class: "settings-lead" }, "A run only gets the key of the provider it uses, passed into its VM for that run."),
    buildKeysTable(),
    el(
      "div",
      { class: "card-muted" },
      el("h2", {}, "Changing keys"),
      el(
        "p",
        {},
        "Keys are read from environment variables such as ",
        el("code", {}, "OPENROUTER_API_KEY"),
        ", or from ",
        el("code", {}, "~/.config/agent-hive/env"),
        " for the CLI and ",
        el("code", {}, ".env"),
        " for the server. Set ",
        el("code", {}, "DEFAULT_PROVIDER"),
        " and ",
        el("code", {}, "DEFAULT_MODEL"),
        " there to change the defaults. Adding, testing and switching keys from this page is coming.",
      ),
    ),
  );

  return el("div", { class: "settings-layout" }, nav, content);
}

// ── boot ──

(async () => {
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
