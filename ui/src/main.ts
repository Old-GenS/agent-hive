/**
 * Agent Hive UI: chat with an agent that works on a repo inside a sandbox, plus a GitHub panel
 * for picking the repo. Everything from the server is rendered as text (escaped) — agent output
 * and repo descriptions are untrusted.
 */
import { GitHubPanel } from "./github-panel.js";
import { STORAGE_KEY, api, esc, getToken, serverUrl, setToken } from "./util.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function formatContent(text: string): string {
  return esc(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

// ── auth ──

async function validateToken(): Promise<{ name: string } | null> {
  try {
    const r = await api("/api/user");
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function renderTokenGate(error = false) {
  $("app").innerHTML = `
    <div class="token-gate"><div class="token-gate-inner">
      <h2>🐝 Agent Hive</h2>
      <p>Enter your API token to continue</p>
      <input type="password" id="tokenInput" placeholder="API token" autofocus>
      <button id="loginBtn">Continue</button>
      <div class="token-error ${error ? "visible" : ""}">Invalid token</div>
    </div></div>`;
  const login = async () => {
    setToken($<HTMLInputElement>("tokenInput").value.trim());
    if (!getToken()) return;
    const user = await validateToken();
    if (!user) return renderTokenGate(true);
    localStorage.setItem(STORAGE_KEY, getToken());
    renderApp(user);
  };
  $("loginBtn").onclick = login;
  $("tokenInput").onkeydown = (e) => { if (e.key === "Enter") login(); };
}

// ── chat ──

let sessionId: string | null = null;
let ws: WebSocket | null = null;
let busy = false;
let bubble: HTMLElement | null = null;
let bubbleText = "";

function addMessage(cls: string, html: string): HTMLElement {
  const area = $("chatMessages");
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
  return div;
}

function setBusy(b: boolean) {
  busy = b;
  $<HTMLButtonElement>("sendBtn").disabled = b;
  $("abortBtn").style.display = b ? "" : "none";
}

function lockSessionControls() {
  for (const id of ["repoInput", "branchInput", "providerSelect", "modelInput", "reviewSelect"]) {
    $<HTMLInputElement>(id).disabled = !!sessionId;
  }
  $("sessionInfo").textContent = sessionId ? `session ${sessionId.slice(0, 8)}` : "";
}

function newSession() {
  ws?.close();
  sessionId = null;
  $("chatMessages").innerHTML = "";
  lockSessionControls();
  setBusy(false);
}

function handleEvent(e: any) {
  const area = $("chatMessages");
  switch (e.type) {
    case "message_start":
      if (e.message?.role === "assistant") {
        bubble = addMessage("assistant streaming", "");
        bubbleText = "";
      }
      break;
    case "message_update":
      if (bubble && e.assistantMessageEvent?.type === "text_delta") {
        bubbleText += e.assistantMessageEvent.delta;
        bubble.innerHTML = formatContent(bubbleText);
        area.scrollTop = area.scrollHeight;
      }
      break;
    case "message_end":
      if (bubble) {
        bubble.classList.remove("streaming");
        if (!bubbleText) bubble.remove();
        bubble = null;
      }
      break;
    case "tool_execution_start": {
      const args = e.args?.command ?? e.args?.path ?? e.args?.file_path ?? "";
      addMessage("tool", `🔧 ${esc(e.toolName)} <code>${esc(String(args).slice(0, 200))}</code>`);
      break;
    }
    case "hive_status": {
      const labels: Record<string, string> = {
        queued: `⏳ queued (${e.running ?? "?"}/${e.max ?? "?"} sandboxes busy)`,
        cloning: "📥 cloning repo",
        running: "🐝 agent working in sandbox",
        reviewing: `🔍 review cycle ${e.cycle}/${e.of}`,
        pushing: "📤 pushing changes",
      };
      if (labels[e.status]) addMessage("system", esc(labels[e.status]));
      break;
    }
    case "hive_done":
      if (e.status === "idle") {
        const cost = e.usage?.cost > 0 ? esc(` · $${Number(e.usage.cost).toFixed(4)}`) : "";
        addMessage("system", e.resultBranch
          ? `✅ done — pushed ${esc(e.commitsPushed)} commit(s) to <strong>${esc(e.resultBranch)}</strong>${cost}`
          : `✅ done${cost}`);
      } else {
        addMessage("system error", `${e.status === "aborted" ? "⏹ aborted" : "❌ failed"}${e.error ? ": " + esc(e.error) : ""}`);
      }
      setBusy(false);
      ws?.close();
      break;
  }
}

async function connect(id: string) {
  ws?.close();
  const r = await api(`/events/${id}/ticket`, { method: "POST" });
  if (!r.ok) throw new Error("couldn't open event stream");
  const { ticket } = await r.json();
  const url = `${serverUrl.replace(/^http/, "ws")}/events/${id}?ticket=${encodeURIComponent(ticket)}`;
  ws = new WebSocket(url);
  ws.onmessage = (m) => {
    try {
      handleEvent(JSON.parse(m.data));
    } catch {}
  };
  ws.onclose = () => {
    if (busy) addMessage("system", "stream closed; check status later");
    setBusy(false);
  };
}

async function sendChat() {
  const input = $<HTMLTextAreaElement>("chatInput");
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  addMessage("user", formatContent(text));
  setBusy(true);

  const body: Record<string, unknown> = { prompt: text };
  const thinking = $<HTMLSelectElement>("thinkingSelect").value;
  if (thinking) body.thinkingLevel = thinking;
  if (sessionId) {
    body.sessionId = sessionId;
  } else {
    const repo = $<HTMLInputElement>("repoInput").value.trim();
    const branch = $<HTMLInputElement>("branchInput").value.trim();
    const provider = $<HTMLSelectElement>("providerSelect").value;
    const model = $<HTMLInputElement>("modelInput").value.trim();
    const review = Number($<HTMLSelectElement>("reviewSelect").value);
    if (repo) body.repo = repo;
    if (repo && branch) body.branch = branch;
    if (provider) body.provider = provider;
    if (model) body.model = model;
    if (repo && review) body.reviewCycles = review;
  }

  try {
    const r = await api("/prompt", { method: "POST", body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    if (!sessionId) {
      sessionId = data.sessionId;
      lockSessionControls();
    }
    await connect(data.sessionId);
  } catch (err: any) {
    addMessage("system error", `❌ ${esc(err.message)}`);
    setBusy(false);
  }
}

async function abort() {
  if (sessionId) await api(`/abort/${sessionId}`, { method: "POST" }).catch(() => {});
}

function useRepo(fullName: string) {
  newSession();
  $<HTMLInputElement>("repoInput").value = fullName;
  switchTab("chat");
  $("chatInput").focus();
}

function switchTab(tab: string) {
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === tab));
}

// ── app ──

function renderApp(user: { name: string }) {
  $("app").innerHTML = `
    <div class="header">
      <div class="header-left">
        <h1>🐝 <span>Agent Hive</span></h1>
        <div class="tabs">
          <button class="tab-btn active" data-tab="chat">💬 Chat</button>
          <button class="tab-btn" data-tab="github">🐙 GitHub</button>
        </div>
      </div>
      <div class="header-right">
        <span class="user-badge">${esc(user.name)}</span>
        <button class="btn-logout" id="logoutBtn">Logout</button>
      </div>
    </div>
    <div class="main">
      <div class="tab-panel active" data-tab="chat">
        <div class="chat-area" id="chatMessages"></div>
        <div class="chat-input-bar">
          <div class="chat-controls">
            <input id="repoInput" class="mini-input wide" placeholder="repo (owner/name) — empty for no repo">
            <input id="branchInput" class="mini-input" placeholder="branch">
            <select id="providerSelect" class="mini-select">
              <option value="">Provider: default</option>
              <option value="deepseek">DeepSeek</option>
              <option value="zai">Z.AI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
            <input id="modelInput" class="mini-input" placeholder="model (default)">
            <select id="thinkingSelect" class="mini-select">
              <option value="">Thinking: default</option>
              <option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option>
            </select>
            <select id="reviewSelect" class="mini-select">
              <option value="0">No review</option><option value="1">1 review cycle</option><option value="2">2 review cycles</option>
            </select>
            <span class="session-info" id="sessionInfo"></span>
            <button class="mini-btn" id="newBtn">New session</button>
          </div>
          <div class="chat-input-row">
            <textarea id="chatInput" rows="1" placeholder="Describe the task… (Enter to send, Shift+Enter for a new line)"></textarea>
            <button id="abortBtn" class="mini-btn" style="display:none">Stop</button>
            <button id="sendBtn">Send</button>
          </div>
        </div>
      </div>
      <div class="tab-panel" data-tab="github">
        <div class="gh-layout">
          <div class="gh-sidebar">
            <div class="gh-sidebar-header">
              <div class="gh-mode-toggle">
                <button class="gh-mode-btn active" id="modeMine">My Repos</button>
                <button class="gh-mode-btn" id="modeSearch">Search</button>
              </div>
              <input type="text" id="repoFilter" placeholder="Filter repos...">
            </div>
            <div class="gh-repo-list" id="repoList"></div>
          </div>
          <div class="gh-main" id="ghMain"><div class="gh-empty">Select a repository from the sidebar</div></div>
        </div>
      </div>
    </div>`;

  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab!)));
  $("logoutBtn").onclick = () => { localStorage.removeItem(STORAGE_KEY); location.reload(); };
  $("sendBtn").onclick = sendChat;
  $("abortBtn").onclick = abort;
  $("newBtn").onclick = newSession;
  const input = $<HTMLTextAreaElement>("chatInput");
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  };
  input.oninput = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; };

  new GitHubPanel(useRepo).init();
  input.focus();
}

(async () => {
  if (!getToken()) return renderTokenGate();
  const user = await validateToken();
  if (!user) {
    localStorage.removeItem(STORAGE_KEY);
    return renderTokenGate();
  }
  renderApp(user);
})();
