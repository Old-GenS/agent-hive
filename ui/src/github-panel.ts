/**
 * GitHub panel: browse your repos or search public ones, then hand one to the chat.
 * Repo names and descriptions come from GitHub and are attacker-controllable for public repos,
 * so they're only ever inserted escaped.
 */
import { api, esc } from "./util.js";

interface Repo {
  name: string;
  nameWithOwner?: string;
  fullName?: string;
  description?: string;
  visibility?: string;
  stargazersCount?: number;
  language?: string;
  isArchived?: boolean;
}

const fullName = (r: Repo) => r.nameWithOwner || r.fullName || r.name;

export class GitHubPanel {
  private repos: Repo[] = [];
  private results: Repo[] = [];
  private mode: "mine" | "search" = "mine";
  private timer?: ReturnType<typeof setTimeout>;
  private active?: string;

  constructor(private useRepo: (fullName: string) => void) {}

  init() {
    document.getElementById("modeMine")!.onclick = () => this.setMode("mine");
    document.getElementById("modeSearch")!.onclick = () => this.setMode("search");
    document.getElementById("repoFilter")!.oninput = () => this.onInput();
    void this.refresh();
  }

  private async refresh() {
    const r = await api("/api/github/repos");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return this.message(data.error || "Couldn't load repos");
    this.repos = data;
    this.render();
  }

  private setMode(mode: "mine" | "search") {
    this.mode = mode;
    document.getElementById("modeMine")!.classList.toggle("active", mode === "mine");
    document.getElementById("modeSearch")!.classList.toggle("active", mode === "search");
    const input = document.getElementById("repoFilter") as HTMLInputElement;
    input.value = "";
    input.placeholder = mode === "search" ? "Search public repos…" : "Filter repos…";
    this.results = [];
    this.render();
  }

  private onInput() {
    if (this.mode === "mine") return this.render();
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const q = (document.getElementById("repoFilter") as HTMLInputElement).value.trim();
      if (!q) return;
      const r = await api(`/api/github/search?q=${encodeURIComponent(q)}`);
      this.results = r.ok ? await r.json() : [];
      this.render();
    }, 400);
  }

  private message(text: string) {
    document.getElementById("repoList")!.innerHTML = `<div class="gh-note">${esc(text)}</div>`;
  }

  private render() {
    const list = document.getElementById("repoList")!;
    const filter = (document.getElementById("repoFilter") as HTMLInputElement).value.toLowerCase();
    const items = this.mode === "mine"
      ? this.repos.filter((r) => !r.isArchived && fullName(r).toLowerCase().includes(filter))
      : this.results;
    if (!items.length) return this.message(this.mode === "search" ? "Type to search" : "No repos");
    list.innerHTML = "";
    for (const r of items) {
      const div = document.createElement("div");
      div.className = "gh-repo-item" + (fullName(r) === this.active ? " active" : "");
      const meta = [r.visibility === "PRIVATE" || r.visibility === "private" ? "🔒" : "",
        r.stargazersCount ? `⭐ ${r.stargazersCount}` : "", r.language || ""].filter(Boolean).join(" ");
      div.innerHTML = `<div class="gh-repo-name">${esc(fullName(r))} <span class="gh-meta">${esc(meta)}</span></div>
        <div class="gh-repo-desc">${esc(r.description || "")}</div>`;
      div.onclick = () => this.select(r);
      list.appendChild(div);
    }
  }

  private select(r: Repo) {
    this.active = fullName(r);
    this.render();
    const main = document.getElementById("ghMain")!;
    main.innerHTML = `
      <div class="gh-detail">
        <h3>${esc(fullName(r))}</h3>
        <p>${esc(r.description || "No description")}</p>
        <div class="gh-detail-btns">
          <button id="ghUse">💬 Work on this repo</button>
          ${this.mode === "search" ? '<button id="ghFork">🍴 Fork, then work on the fork</button>' : ""}
        </div>
        <p class="gh-note">The agent works on a copy in a sandbox and its commits are pushed to a new
        <code>hive/…</code> branch. Pushing needs a deploy key (or gh access) for this repo on the server.</p>
        <div id="ghMsg" class="gh-note"></div>
      </div>`;
    document.getElementById("ghUse")!.onclick = () => this.useRepo(fullName(r));
    const fork = document.getElementById("ghFork");
    if (fork) {
      fork.onclick = async () => {
        document.getElementById("ghMsg")!.textContent = "Forking…";
        const res = await api("/api/github/fork", { method: "POST", body: JSON.stringify({ repo: fullName(r) }) });
        const data = await res.json();
        if (!res.ok) {
          document.getElementById("ghMsg")!.textContent = data.error || "Fork failed";
          return;
        }
        this.useRepo(data.repo);
      };
    }
  }
}
