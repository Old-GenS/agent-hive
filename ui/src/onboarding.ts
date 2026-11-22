/**
 * First-run onboarding (`#setup`): Welcome → Check this computer → Add a model key → GitHub
 * (optional) → Ready. Every view is built from the server's answer with el() and text nodes; no
 * server text is ever parsed as markup.
 *
 * The flow is self-contained: main.ts renders this page at #setup, and the two callbacks remember
 * that setup was done and take the user to the Runs page.
 */
import { api, el } from "./util.js";
import { githubConnect } from "./github-connect.js";

export interface SetupOptions {
  /** Remember that setup is done (the caller owns localStorage). */
  dismiss: () => void;
  /** Leave setup for the Runs page, focusing the task box. */
  startRun: () => void;
}

interface Fix {
  text: string;
  command?: string;
}

interface SetupCheck {
  name: string;
  id: string;
  ok: boolean;
  detail: string;
  fix?: Fix;
}

interface Download {
  state: "idle" | "downloading" | "done" | "error";
  received: number;
  total: number | undefined;
  error?: string;
}

interface OnboardingData {
  needed: boolean;
  checks: SetupCheck[];
  hasKey: boolean;
  defaultProvider: string | null;
  github: { connected: boolean; login?: string; error?: string };
  host: { distro: string; wsl: boolean; bundle: boolean };
  rootfs: { ok: boolean; canDownload: boolean; download: Download };
}

interface ProviderEntry {
  id: string;
  label: string;
  hasKey: boolean;
  model: string | null;
}

interface ProvidersData {
  default: { provider: string | null; model: string | null };
  providers: ProviderEntry[];
}

const STEP_LABELS = ["Welcome", "This computer", "Model key", "GitHub", "Ready"];
const LAST_STEP = STEP_LABELS.length;

/** The mockup's hexagon mark, repeated here so this module doesn't import main.ts. */
function setupLogo(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const node = (tag: string, attrs: Record<string, string>): SVGElement => {
    const element = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    return element;
  };
  const svg = node("svg", { width: "24", height: "24", viewBox: "0 0 28 28", "aria-hidden": "true" });
  svg.append(
    node("path", {
      d: "M14 3l9.5 5.5v11L14 25l-9.5-5.5v-11z",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linejoin": "round",
    }),
    node("path", { d: "M14 9l4.8 2.8v5.4L14 20l-4.8-2.8v-5.4z", fill: "var(--accent)" }),
  );
  return svg as SVGSVGElement;
}

/** A check or cross mark, drawn rather than typed: common Linux fonts lack U+2713/U+2717. */
function markIcon(kind: "check" | "cross"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", kind === "check" ? "M3 8.5l3.2 3.2L13 4.9" : "M4 4l8 8M12 4l-8 8");
  svg.append(path);
  return svg as SVGSVGElement;
}

/** "12.4 MB" (or "820 KB") for the download progress line. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** A `<code>` line with a Copy button; the clipboard itself may be unavailable. */
function copyBox(text: string): HTMLElement {
  const code = el("code", { class: "setup-command-text" }, text);
  const button = el("button", { class: "btn btn-small setup-copy", type: "button" }, "Copy");
  button.onclick = () => {
    const finish = (label: string): void => {
      button.textContent = label;
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1500);
    };
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      finish("Select and copy");
      return;
    }
    clipboard.writeText(text).then(
      () => finish("Copied"),
      () => finish("Select and copy"),
    );
  };
  return el("div", { class: "setup-command" }, code, button);
}

export function buildSetupPage(options: SetupOptions): HTMLElement {
  const page = el("section", { class: "onboarding", id: "onboarding" });
  const card = el("div", { class: "onboarding-card" });
  page.append(card);

  const state = {
    step: 1,
    data: null as OnboardingData | null,
    loaded: false,
    error: null as string | null,
    providers: null as ProvidersData | null,
    providersError: null as string | null,
    provider: "",
    keyInput: "",
    keyBusy: false,
    keyError: null as string | null,
    keySaved: null as { provider: string; detail: string } | null,
    makeDefaultBusy: false,
    makeDefaultError: null as string | null,
    downloadPoll: undefined as number | undefined,
  };

  // ── data ──

  async function loadData(): Promise<void> {
    try {
      const res = await api("/api/onboarding");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      state.data = (await res.json()) as OnboardingData;
      state.error = null;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    state.loaded = true;
    render();
  }

  async function loadProviders(): Promise<void> {
    try {
      const res = await api("/api/providers");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      state.providers = (await res.json()) as ProvidersData;
      state.providersError = null;
    } catch (err) {
      state.providers = null;
      state.providersError = err instanceof Error ? err.message : String(err);
    }
  }

  function providerLabel(id: string | null): string {
    if (id === null) return "none";
    return state.providers?.providers.find((provider) => provider.id === id)?.label ?? state.data?.defaultProvider ?? id;
  }

  function defaultProviderLabel(): string {
    const id = state.data?.defaultProvider ?? null;
    return id === null ? "none" : providerLabel(id);
  }

  function defaultModel(id: string | null): string | null {
    if (id === null) return null;
    return state.providers?.providers.find((provider) => provider.id === id)?.model ?? null;
  }

  // ── the page shell ──

  function header(): HTMLElement {
    const skip = el("button", { class: "btn btn-small btn-ghost setup-skip", id: "setup-skip", type: "button" }, "Skip setup");
    skip.onclick = () => {
      options.dismiss();
      location.hash = "#runs";
    };
    return el(
      "div",
      { class: "onboarding-head" },
      el("div", { class: "onboarding-brand" }, setupLogo(), "hive"),
      skip,
    );
  }

  function stepIndicator(): HTMLElement {
    const list = el("ol", { class: "setup-steps", id: "setup-steps", "aria-label": "Setup steps" });
    STEP_LABELS.forEach((label, index) => {
      const number = index + 1;
      const item = el(
        "li",
        { class: `setup-step${number === state.step ? " is-current" : ""}${number < state.step ? " is-done" : ""}` },
        el("span", { class: "setup-step-num", "aria-hidden": "true" }, number < state.step ? markIcon("check") : String(number)),
        el("span", { class: "setup-step-label" }, label),
      );
      if (number === state.step) item.setAttribute("aria-current", "step");
      list.append(item);
    });
    return list;
  }

  function content(): HTMLElement {
    switch (state.step) {
      case 2:
        return computerStep();
      case 3:
        return keyStep();
      case 4:
        return githubStep();
      case 5:
        return readyStep();
      default:
        return welcomeStep();
    }
  }

  function footer(): HTMLElement {
    const back = el("button", { class: "btn", id: "setup-back", type: "button" }, "Back");
    back.disabled = state.step === 1;
    back.onclick = () => {
      if (state.step > 1) {
        state.step--;
        render();
      }
    };
    const next = el("button", { class: "btn btn-primary", id: "setup-next", type: "button" }, nextLabel());
    next.onclick = () => void goNext();
    if (state.step === LAST_STEP) next.hidden = true;
    return el("div", { class: "onboarding-footer" }, back, next);
  }

  function checksFailing(): boolean {
    return state.data?.checks.some((check) => !check.ok) ?? false;
  }

  function nextLabel(): string {
    if (state.step === 2) return checksFailing() ? "Continue anyway" : "Next";
    if (state.step === 3) return state.data?.hasKey || state.keySaved ? "Next" : "Continue anyway";
    if (state.step === 4) return state.data?.github.connected ? "Next" : "Skip";
    return "Next";
  }

  async function goNext(): Promise<void> {
    if (state.step >= LAST_STEP) return;
    state.step++;
    // The key and summary steps show provider labels and default models.
    if ((state.step === 3 || state.step === LAST_STEP) && state.providers === null && state.providersError === null) {
      await loadProviders();
    }
    if (state.step === LAST_STEP) {
      // Reaching the summary is finishing setup: remember it even if the user leaves from here.
      options.dismiss();
    }
    render();
  }

  function startPollingIfDownloading(): void {
    const downloading = state.data?.rootfs.download.state === "downloading";
    if (!downloading) {
      stopPolling();
      return;
    }
    if (state.downloadPoll !== undefined) return;
    state.downloadPoll = window.setInterval(() => {
      if (!card.isConnected) {
        stopPolling();
        return;
      }
      void api("/api/onboarding")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data) return;
          state.data = data as OnboardingData;
          render();
        })
        .catch(() => {
          // Keep the last numbers; the next tick tries again.
        });
    }, 1000);
  }

  function stopPolling(): void {
    if (state.downloadPoll === undefined) return;
    window.clearInterval(state.downloadPoll);
    state.downloadPoll = undefined;
  }

  let renderedStep = 0;
  function render(): void {
    // The step changed: anything the previous step started polling is stale.
    if (renderedStep !== state.step) {
      renderedStep = state.step;
      stopPolling();
    }
    card.replaceChildren(header(), stepIndicator(), el("div", { class: "onboarding-body" }, content()), footer());
    startPollingIfDownloading();
  }

  // ── step 1: welcome ──

  function welcomeStep(): HTMLElement {
    return el(
      "div",
      { class: "setup-step-body" },
      el("h1", {}, "Welcome to hive"),
      el("p", { class: "setup-lead" }, "A coding agent in a throwaway microVM, on this computer."),
      el(
        "ul",
        { class: "setup-points" },
        el("li", {}, "hive runs a coding agent on your code inside its own microVM, on this computer."),
        el("li", {}, "Nothing secret goes in but one model key: no SSH keys, no GitHub login."),
        el("li", {}, "You review everything before it reaches your repo or GitHub: the work stays on a branch."),
      ),
      el("p", { class: "setup-hint" }, "This takes a few minutes. You can stop at any step and run setup again from Settings."),
    );
  }

  // ── step 2: check this computer ──

  function fixElement(fix: Fix): HTMLElement {
    const box = el("div", { class: "setup-fix" }, el("p", { class: "setup-fix-text" }, fix.text));
    if (fix.command !== undefined) box.append(copyBox(fix.command));
    return box;
  }

  function checkRow(check: SetupCheck): HTMLElement {
    const row = el(
      "li",
      { class: `setup-check${check.ok ? " is-ok" : " is-failed"}`, "data-check": check.id },
      el(
        "span",
        { class: "setup-check-mark", "aria-hidden": "true", title: check.ok ? "Passed" : "Failed" },
        markIcon(check.ok ? "check" : "cross"),
      ),
      el(
        "div",
        { class: "setup-check-body" },
        el("span", { class: "setup-check-name" }, check.name),
        el("span", { class: "setup-check-detail" }, check.detail),
      ),
    );
    if (!check.ok && check.fix) row.append(fixElement(check.fix));
    return row;
  }

  function downloadBlock(download: Download): HTMLElement {
    const block = el("div", { class: "setup-download", id: "setup-download-state" });
    if (download.state === "downloading") {
      const percent =
        download.total !== undefined && download.total > 0
          ? Math.min(100, Math.round((download.received / download.total) * 100))
          : undefined;
      const fill = el("div", { class: "setup-progress-fill" });
      if (percent !== undefined) fill.style.width = `${percent}%`;
      const label =
        download.total !== undefined && download.total > 0
          ? `${formatBytes(download.received)} of ${formatBytes(download.total)}`
          : formatBytes(download.received);
      block.append(
        el("p", { class: "setup-download-text" }, `Downloading the VM filesystem… ${label}`),
        el(
          "div",
          {
            class: "setup-progress",
            role: "progressbar",
            "aria-label": "VM filesystem download",
            "aria-valuemin": "0",
            "aria-valuemax": "100",
            ...(percent !== undefined ? { "aria-valuenow": String(percent) } : {}),
          },
          fill,
        ),
      );
      return block;
    }
    if (download.state === "done") {
      block.append(el("p", { class: "setup-download-done" }, "VM filesystem downloaded."));
      return block;
    }
    if (download.state === "error") {
      block.append(el("p", { class: "alert alert-danger", role: "alert" }, `Download failed: ${download.error ?? "unknown error"}`));
      return block;
    }
    return block;
  }

  async function startDownload(): Promise<void> {
    try {
      const res = await api("/api/setup/rootfs", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
      }
      if (state.data) state.data.rootfs.download = { state: "downloading", received: 0, total: undefined };
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    render();
  }

  function computerStep(): HTMLElement {
    const body = el("div", { class: "setup-step-body" }, el("h1", {}, "Check this computer"), el("p", { class: "setup-lead" }, "hive needs these to start a microVM."));
    if (state.error) {
      body.append(el("p", { class: "alert alert-danger", role: "alert" }, state.error));
    }
    if (!state.data) {
      body.append(el("p", { class: "cell-muted" }, state.loaded ? "Couldn't read this computer's setup." : "Checking…"));
      const retry = el("button", { class: "btn", id: "setup-check-again", type: "button" }, "Check again");
      retry.onclick = () => void loadData();
      body.append(retry);
      return body;
    }
    const checks = el("ul", { class: "setup-checks", id: "setup-checks" });
    for (const check of state.data.checks) checks.append(checkRow(check));
    body.append(checks);

    const download = state.data.rootfs.download;
    if (state.data.rootfs.canDownload || download.state !== "idle") {
      if (state.data.rootfs.canDownload && (download.state === "idle" || download.state === "error")) {
        const button = el("button", { class: "btn btn-primary", id: "setup-download", type: "button" }, "Download VM filesystem");
        button.onclick = () => void startDownload();
        body.append(el("div", { class: "setup-download-row" }, button));
      }
      body.append(downloadBlock(download));
    }

    if (state.data.host.wsl) {
      body.append(
        el(
          "p",
          { class: "setup-note" },
          "On WSL, hive needs nested virtualization turned on, and for now the Fedora WSL distro.",
        ),
      );
    }

    const again = el("button", { class: "btn", id: "setup-check-again", type: "button" }, "Check again");
    again.disabled = state.data.rootfs.download.state === "downloading";
    again.onclick = () => void loadData();
    body.append(el("div", { class: "setup-actions" }, again));
    return body;
  }

  // ── step 3: add a model key ──

  async function saveKey(form: HTMLElement): Promise<void> {
    const select = form.querySelector<HTMLSelectElement>("#setup-provider");
    const input = form.querySelector<HTMLInputElement>("#setup-key");
    const provider = select?.value ?? state.provider;
    const key = input?.value.trim() ?? "";
    if (!provider) {
      state.keyError = "Pick a provider first.";
      render();
      return;
    }
    if (!key) {
      state.keyError = "Paste the key first.";
      render();
      return;
    }
    state.keyBusy = true;
    state.keyError = null;
    render();
    try {
      const res = await api("/api/keys", { method: "POST", body: JSON.stringify({ provider, key }) });
      const body = (await res.json().catch(() => ({}))) as { detail?: unknown; error?: unknown };
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
      state.keySaved = { provider, detail: typeof body.detail === "string" ? body.detail : "" };
      state.keyInput = "";
      await loadProviders();
      await loadData();
      return;
    } catch (err) {
      state.keyError = err instanceof Error ? err.message : String(err);
    } finally {
      state.keyBusy = false;
    }
    render();
  }

  async function makeDefault(provider: string): Promise<void> {
    state.makeDefaultBusy = true;
    state.makeDefaultError = null;
    render();
    try {
      const res = await api("/api/keys/default", { method: "PUT", body: JSON.stringify({ provider }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
      }
      state.makeDefaultBusy = false;
      await loadData();
      return;
    } catch (err) {
      state.makeDefaultError = err instanceof Error ? err.message : String(err);
    }
    state.makeDefaultBusy = false;
    render();
  }

  function keySavedBlock(): HTMLElement {
    const saved = state.keySaved as { provider: string; detail: string };
    const body = el(
      "div",
      { class: "setup-step-body" },
      el("h1", {}, "Add a model key"),
      el("p", { class: "setup-lead" }, `${providerLabel(saved.provider)} is ready.`),
      el("p", { class: "setup-note" }, saved.detail || "The provider accepted the key."),
    );
    const model = defaultModel(saved.provider);
    if (model !== null) body.append(el("p", {}, `Default model: ${model}`));
    const others = state.providers?.providers.some((provider) => provider.hasKey && provider.id !== saved.provider) ?? false;
    const isDefault = state.data?.defaultProvider === saved.provider;
    if (others && !isDefault) {
      const button = el("button", { class: "btn", id: "setup-make-default", type: "button" }, "Make default");
      button.disabled = state.makeDefaultBusy;
      button.onclick = () => void makeDefault(saved.provider);
      body.append(el("div", { class: "setup-actions" }, button));
    }
    if (state.makeDefaultError) body.append(el("p", { class: "alert alert-danger", role: "alert" }, state.makeDefaultError));
    return body;
  }

  function keyStep(): HTMLElement {
    if (state.keySaved) return keySavedBlock();
    if (state.data?.hasKey) {
      const provider = state.data.defaultProvider;
      const model = defaultModel(provider);
      return el(
        "div",
        { class: "setup-step-body" },
        el("h1", {}, "Add a model key"),
        el("p", { class: "setup-lead" }, "A model key is ready."),
        el("p", {}, `Default provider: ${defaultProviderLabel()}`),
        model !== null ? el("p", { class: "setup-note" }, `Default model: ${model}`) : null,
        el("p", { class: "setup-hint" }, "You can add or change keys later in Settings › API keys."),
      );
    }
    const body = el(
      "div",
      { class: "setup-step-body" },
      el("h1", {}, "Add a model key"),
      el("p", { class: "setup-lead" }, "The sandbox gets this key and nothing else."),
    );
    if (state.providersError) body.append(el("p", { class: "alert alert-danger", role: "alert" }, state.providersError));
    if (state.providers === null) {
      body.append(el("p", { class: "cell-muted" }, "Loading providers…"));
      return body;
    }
    const providers = state.providers.providers;
    if (providers.length === 0) {
      body.append(el("p", { class: "cell-muted" }, "No providers are configured on this server."));
      return body;
    }
    const select = el("select", { id: "setup-provider" });
    for (const provider of providers) select.append(el("option", { value: provider.id }, provider.label));
    if (!state.provider) state.provider = providers.find((provider) => !provider.hasKey)?.id ?? providers[0].id;
    select.value = state.provider;
    select.addEventListener("change", () => {
      state.provider = select.value;
      state.keyError = null;
    });
    const input = el("input", {
      id: "setup-key",
      type: "password",
      autocomplete: "off",
      placeholder: "Paste the key",
      "aria-label": "Model key",
    });
    input.value = state.keyInput;
    input.addEventListener("input", () => {
      state.keyInput = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void saveKey(form);
      }
    });
    const button = el("button", { class: "btn btn-primary", id: "setup-save-key", type: "submit" }, state.keyBusy ? "Testing…" : "Test and save");
    button.disabled = state.keyBusy;
    const form = el(
      "form",
      { class: "setup-form", id: "setup-key-form" },
      el("div", { class: "field" }, el("label", { for: "setup-provider" }, "Provider"), select),
      el("div", { class: "field" }, el("label", { for: "setup-key" }, "Key"), input),
      el("p", { class: "field-hint" }, "It is tested before it is saved; a rejected key is never written."),
      button,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveKey(form);
    });
    if (state.keyError) body.append(el("p", { class: "alert alert-danger", role: "alert" }, state.keyError));
    body.append(form);
    return body;
  }

  // ── step 4: GitHub ──

  function githubStep(): HTMLElement {
    const body = el("div", { class: "setup-step-body" }, el("h1", {}, "GitHub (optional)"));
    const github = state.data?.github;
    if (github?.connected) {
      body.append(
        el("p", { class: "setup-lead" }, `Signed in to GitHub as ${github.login ?? "your account"}.`),
        el("p", {}, "hive can list your repos, push branches and open pull requests."),
      );
    } else {
      body.append(
        el("p", { class: "setup-lead" }, "GitHub is optional: local repos and the terminal still work."),
        el("p", {}, "Sign in with the GitHub CLI so hive can list your repos, push branches and open pull requests."),
        githubConnect({ reload: () => void loadData(), checkId: "setup-github-check" }),
      );
    }
    return body;
  }

  // ── step 5: ready ──

  function readyStep(): HTMLElement {
    const checks = state.data?.checks ?? [];
    const passed = checks.filter((check) => check.ok).length;
    const failed = checks.filter((check) => !check.ok);
    const summary = el("ul", { class: "setup-summary", id: "setup-summary" });
    summary.append(
      el(
        "li",
        {},
        el("span", { class: "setup-summary-label" }, "This computer"),
        failed.length === 0
          ? `All ${checks.length} checks passed.`
          : `${passed} of ${checks.length} checks passed: ${failed.map((check) => check.name).join(", ")}.`,
      ),
      el(
        "li",
        {},
        el("span", { class: "setup-summary-label" }, "Model key"),
        state.data?.hasKey
          ? `${defaultProviderLabel()}${defaultModel(state.data.defaultProvider) ? ` (${defaultModel(state.data.defaultProvider)})` : ""}`
          : "No key yet; add one in Settings.",
      ),
      el(
        "li",
        {},
        el("span", { class: "setup-summary-label" }, "GitHub"),
        state.data?.github.connected
          ? `Signed in as ${state.data.github.login ?? "your account"}`
          : "Not connected (optional)",
      ),
    );
    const start = el("button", { class: "btn btn-primary", id: "setup-start-run", type: "button" }, "Start your first run");
    start.onclick = () => {
      options.dismiss();
      options.startRun();
    };
    return el(
      "div",
      { class: "setup-step-body" },
      el("h1", {}, "Ready"),
      el("p", { class: "setup-lead" }, "hive is set up. Give the bees their first task."),
      summary,
      el("div", { class: "setup-actions" }, start),
      el("h2", { class: "setup-subtitle" }, "From the terminal"),
      el("p", { class: "setup-hint" }, "Run this from inside a git repository:"),
      copyBox('hive run "<task>"'),
    );
  }

  // ── boot ──

  render();
  void loadData();
  return page;
}
