/**
 * The Connect GitHub flow, shared by first-run setup (step 4) and Settings › This computer.
 *
 * The server runs `gh auth login --web` for us; this module shows the one-time code and the
 * device link, polls until the login finishes, and then asks the page to reload its data. All
 * server text is put on the page as text nodes, never as markup.
 */
import { api, el } from "./util.js";

interface GithubLoginState {
  state: "idle" | "starting" | "waiting" | "done" | "error";
  code?: string;
  url?: string;
  login?: string;
  error?: string;
}

export interface GithubConnectOptions {
  /** Reload the page's data after the flow or **Check again**; the caller re-renders. */
  reload: () => void;
  /** id for the **Check again** button, when an existing page (or the UI smoke test) looks it up. */
  checkId?: string;
  /**
   * Run `gh auth refresh` for the workflow scope instead of a login: for a login that cannot push
   * `.github/workflows`. The server needs only the body `{ "refresh": true }`, and the flow starts
   * as soon as the control is shown (the person already clicked the warning's Fix button).
   */
  refresh?: boolean;
}

const DEVICE_URL = "https://github.com/login/device";

/** A Copy button that says what happened, then goes back to its label. */
function copyButton(text: string, label: string): HTMLElement {
  const button = el("button", { class: "btn btn-small", type: "button" }, label);
  button.onclick = () => {
    const finish = (next: string): void => {
      button.textContent = next;
      window.setTimeout(() => {
        button.textContent = label;
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
  return button;
}

/**
 * The inline Connect GitHub control for a page that is not connected: the button, the terminal
 * alternative and **Check again**, then the code box and its poll.
 */
export function githubConnect(options: GithubConnectOptions): HTMLElement {
  const box = el("div", { class: "github-connect" });
  let poll: number | undefined;
  let busy = false;

  function stopPolling(): void {
    if (poll === undefined) return;
    window.clearInterval(poll);
    poll = undefined;
  }

  function terminalAlternative(): HTMLElement {
    const command = options.refresh ? "gh auth refresh -h github.com -s workflow" : "gh auth login";
    return el(
      "div",
      { class: "github-terminal" },
      el("p", { class: "setup-hint" }, "Or in a terminal:"),
      el(
        "div",
        { class: "setup-command" },
        el("code", { class: "setup-command-text" }, command),
        copyButton(command, "Copy"),
      ),
    );
  }

  function idleView(): void {
    stopPolling();
    const connect = el(
      "button",
      { class: "btn btn-primary github-connect-btn", type: "button" },
      options.refresh ? "Refresh GitHub permission" : "Connect GitHub",
    );
    connect.onclick = () => void start();
    const again = el("button", { class: "btn github-connect-check", id: options.checkId, type: "button" }, "Check again");
    again.onclick = () => {
      if (!busy) options.reload();
    };
    box.replaceChildren(
      el("div", { class: "setup-actions" }, connect),
      terminalAlternative(),
      el("div", { class: "setup-actions" }, again),
    );
  }

  function startingView(): void {
    box.replaceChildren(el("p", { class: "setup-hint github-connect-starting", role: "status" }, "Starting…"));
  }

  function waitingView(state: GithubLoginState): void {
    const code = state.code ?? "";
    const url = state.url && /^https:\/\/github\.com\/login\/device/.test(state.url) ? state.url : DEVICE_URL;
    const cancel = el("button", { class: "btn btn-small btn-ghost github-connect-cancel", type: "button" }, "Cancel");
    cancel.onclick = () => void cancelLogin();
    box.replaceChildren(
      el("div", { class: "github-code-box" }, el("code", { class: "github-code" }, code), copyButton(code, "Copy code")),
      el("p", { class: "setup-hint" }, "Enter the code on GitHub, then come back here."),
      el(
        "div",
        { class: "setup-actions" },
        el(
          "a",
          {
            class: "btn",
            href: url,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Open github.com/login/device",
        ),
        cancel,
      ),
    );
    startPolling();
  }

  function errorView(message: string): void {
    stopPolling();
    const retry = el("button", { class: "btn btn-primary github-connect-retry", type: "button" }, "Try again");
    retry.onclick = () => void start();
    box.replaceChildren(
      el("p", { class: "alert alert-danger", role: "alert" }, message),
      el("div", { class: "setup-actions" }, retry),
    );
  }

  function handle(state: GithubLoginState): void {
    switch (state.state) {
      case "waiting":
        waitingView(state);
        return;
      case "done":
        stopPolling();
        options.reload();
        return;
      case "error":
        errorView(state.error || "The GitHub login failed.");
        return;
      case "idle":
        idleView();
        return;
      default:
        startingView();
        return;
    }
  }

  async function pollOnce(): Promise<void> {
    if (!box.isConnected) {
      stopPolling();
      return;
    }
    try {
      const res = await api("/api/github/login");
      if (!res.ok || !box.isConnected) return;
      handle((await res.json()) as GithubLoginState);
    } catch {
      // Try again on the next tick.
    }
  }

  function startPolling(): void {
    if (poll !== undefined) return;
    poll = window.setInterval(() => void pollOnce(), 2000);
  }

  async function start(): Promise<void> {
    if (busy) return;
    busy = true;
    startingView();
    try {
      const res = await api("/api/github/login", {
        method: "POST",
        ...(options.refresh ? { body: JSON.stringify({ refresh: true }) } : {}),
      });
      const state = (await res.json().catch(() => ({}))) as GithubLoginState & { error?: string };
      if (!res.ok) {
        errorView(state.error || `Request failed (${res.status})`);
        return;
      }
      handle(state);
    } catch (err) {
      errorView(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }

  async function cancelLogin(): Promise<void> {
    stopPolling();
    try {
      await api("/api/github/login", { method: "DELETE" });
    } catch {
      // The server resets to idle on its own when it is reachable again.
    }
    idleView();
  }

  idleView();
  // Opened from a Fix button: start the refresh right away.
  if (options.refresh) void start();
  return box;
}
