// UI smoke test (Acceptance only): boots the built server, drives the built UI in headless
// Chromium, asserts the key behaviours and saves screenshots. Never starts a run.
//
//   npm i --no-save playwright-core@1.49.1 && node scripts/ui-smoke.mjs
//
import { deepStrictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = "smoke-token-0123456789abcdef";
const PORT = "18123";
const BASE = `http://127.0.0.1:${PORT}`;
const CHROMIUM = "/usr/lib64/chromium-browser/chromium-browser";

const workspace = mkdtempSync(join(tmpdir(), "hive-ui-smoke-"));
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    API_TOKEN: TOKEN,
    PORT,
    HOST: "127.0.0.1",
    WORKSPACE: workspace,
    DEEPSEEK_API_KEY: "sk-smoke",
    OPENROUTER_API_KEY: "sk-smoke",
    HIVE_DOTENV_PATH: "/nonexistent",
    // Keys are written here, never to the real ~/.config/agent-hive/env.
    HIVE_KEYS_FILE: join(workspace, "keys-env"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
for (const stream of [server.stdout, server.stderr]) {
  stream?.on("data", (chunk) => {
    serverLog = (serverLog + String(chunk)).slice(-4000);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not answer /health within 20 s\n${serverLog}`);
}

async function login(page) {
  await page.goto(`${BASE}/ui/`);
  // The main flows are not about first-run setup: mark it done before signing in.
  await page.evaluate(() => localStorage.setItem("hive-onboarding-done", "1"));
  await page.fill("#token", TOKEN);
  await page.click("#loginBtn");
  await page.waitForSelector("#provider", { timeout: 15_000 });
}

let browser = null;
let exitCode = 0;
try {
  await waitForHealth();

  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--headless=new"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // ── desktop: new-run form ──
  await login(page);

  const providerOptions = await page.$$eval("#provider option", (nodes) =>
    nodes.map((node) => ({ value: node.value, disabled: node.disabled })),
  );
  assert(
    providerOptions.some((option) => option.value === "deepseek" && !option.disabled),
    "provider select has an enabled deepseek option",
  );
  assert(
    providerOptions.some((option) => option.value === "zai" && option.disabled),
    "provider select has a disabled zai option (no key)",
  );

  await page.selectOption("#provider", "deepseek");
  await page.waitForFunction(() => document.querySelectorAll("#modelOptions option").length > 0, null, {
    timeout: 10_000,
  });

  const placeholder = await page.$eval("#model", (node) => node.placeholder);
  assert(placeholder === "deepseek-flash", `#model placeholder is deepseek-flash (got ${JSON.stringify(placeholder)})`);

  const hasEmoji = await page.evaluate(() => /\p{Extended_Pictographic}/u.test(document.body.innerText));
  assert(!hasEmoji, "no element text contains an emoji");
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-desktop.png") });

  // ── desktop: run view (bee indicator; never reaches the real /prompt) ──
  await page.route("**/prompt", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "demo-session",
        status: "queued",
        repo: null,
        provider: "deepseek",
        model: "deepseek-v4-pro",
      }),
    }),
  );
  await page.route("**/events/demo-session/ticket", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "demo" }) }),
  );
  let demoSocket = null;
  await page.routeWebSocket(/\/events\/demo-session/, (ws) => {
    demoSocket = ws;
    ws.send(JSON.stringify({ type: "hive_status", status: "queued", running: 0, max: 2 }));
    ws.send(JSON.stringify({ type: "hive_status", status: "running" }));
    ws.send(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }));
  });

  // Playwright installs the WebSocket interception hook as an init script, so the document has
  // to load after the route is registered. The token is in localStorage, so a reload lands back
  // on the new-run form.
  await page.reload();
  await page.waitForSelector("#provider");

  await page.fill("#task", "demo task");
  await page.click("#startBtn");
  await page.waitForSelector('.bee-indicator[data-state="working"]');
  const beeLabel = await page.$eval(".bee-label", (node) => (node.textContent ?? "").trim());
  assert(
    beeLabel === "Agent working in the microVM",
    `bee label is Agent working in the microVM (got ${JSON.stringify(beeLabel)})`,
  );
  const headerBees = await page.$$eval(".header-bee", (nodes) => nodes.length);
  assert(headerBees === 1, `header shows one bee while the run is busy (got ${headerBees})`);
  const stepsWorking = await page.$$eval(".item-status[data-step]", (nodes) => nodes.map((n) => n.dataset.step));
  assert(
    JSON.stringify(stepsWorking) === JSON.stringify(["done", "current"]),
    `queued is ticked off and running is current (got ${JSON.stringify(stepsWorking)})`,
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-run-working.png") });

  demoSocket.send(
    JSON.stringify({
      type: "hive_done",
      status: "idle",
      resultBranch: "hive/demo1234",
      commitsPushed: 2,
      repoSlug: "demo/repo",
      changes: {
        commits: ["Fix the loading state", "Document the focus page"],
        files: [
          { path: "index.html", added: 19, removed: 10 },
          { path: "README.md", added: 6, removed: 0 },
          { path: "logo.png", added: null, removed: null },
        ],
        moreFiles: 0,
      },
      usage: { cost: 0.0123 },
    }),
  );
  await page.waitForSelector('.bee-indicator[data-state="done"]');
  const stepsDone = await page.$$eval(".item-status[data-step]", (nodes) => nodes.map((n) => n.dataset.step));
  assert(
    JSON.stringify(stepsDone) === JSON.stringify(["done", "done"]),
    `every step is ticked off when the run is done (got ${JSON.stringify(stepsDone)})`,
  );
  const changedFiles = await page.$$eval(".changes-files li", (nodes) => nodes.length);
  assert(changedFiles === 3, `the result lists the files changed (got ${changedFiles})`);
  const compareHref = await page.$eval(".banner-link", (a) => a.getAttribute("href"));
  assert(
    compareHref === "https://github.com/demo/repo/compare/hive/demo1234",
    `the result links to the changes on GitHub (got ${compareHref})`,
  );
  await page.route("**/pr/demo-session", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "https://github.com/demo/repo/pull/7" }) }),
  );
  await page.click("#openPrBtn");
  await page.waitForSelector("#prLink");
  const prHref = await page.$eval("#prLink", (a) => a.getAttribute("href"));
  assert(prHref === "https://github.com/demo/repo/pull/7", `View pull request links to the PR (got ${prHref})`);
  await page.unroute("**/pr/demo-session");
  const headerBeesDone = await page.$$eval(".header-bee", (nodes) => nodes.length);
  assert(headerBeesDone === 0, `header bee is removed when the run is done (got ${headerBeesDone})`);
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-run-done.png") });

  await page.emulateMedia({ reducedMotion: "reduce" });
  const beeAnimation = await page.evaluate(() => getComputedStyle(document.querySelector(".bee-flight")).animationName);
  assert(beeAnimation === "none", `reduced motion stops the bee flight (got ${beeAnimation})`);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.unroute("**/prompt");
  await page.unroute("**/events/demo-session/ticket");
  await page.click("#newRunBtn");
  await page.waitForSelector("#provider");

  // ── desktop: new-project form ──
  await page.click("#mode-new");
  assert(await page.isHidden("#repo"), "#repo is hidden in the new-project mode");
  assert(await page.isVisible("#newRepoName"), "#newRepoName is visible in the new-project mode");
  await page.fill("#newRepoName", "bad name");
  const startDisabled = await page.$eval("#startBtn", (node) => node.disabled);
  assert(startDisabled, "#startBtn is disabled while the project name is invalid");
  await page.fill("#newRepoName", "demo-project");
  assert(await page.isHidden("#reviewModelField"), "the reviewer model is hidden without review cycles");
  await page.selectOption("#review", "1");
  assert(await page.isVisible("#reviewModelField"), "picking a review cycle shows the reviewer model");
  await page.fill("#reviewModel", "deepseek-v4-pro");
  await page.fill("#task", "new project task");
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-new-project.png") });

  let captured = null;
  await page.route("**/prompt", async (route) => {
    captured = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "demo-new",
        status: "queued",
        repo: null,
        newRepo: "demo-project",
        provider: "deepseek",
        model: "deepseek-v4-pro",
      }),
    });
  });
  await page.route("**/events/demo-new/ticket", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "demo" }) }),
  );
  await page.click("#startBtn");
  await page.waitForSelector(".run-meta");
  assert(captured !== null, "the new-project /prompt body was captured");
  deepStrictEqual(captured.newRepo, { name: "demo-project", private: true });
  assert(captured.repo === undefined, "a new project never sends repo");
  assert(captured.branch === undefined, "a new project never sends branch");
  assert(captured.reviewCycles === 1, `review cycles are sent (got ${captured.reviewCycles})`);
  assert(captured.reviewModel === "deepseek-v4-pro", `the reviewer model is sent (got ${captured.reviewModel})`);
  const runMeta = await page.$eval(".run-meta", (node) => (node.textContent ?? "").trim());
  assert(
    runMeta.includes("new project demo-project"),
    `run meta says new project demo-project (got ${JSON.stringify(runMeta)})`,
  );
  await page.unroute("**/prompt");
  await page.unroute("**/events/demo-new/ticket");
  await page.click("#newRunBtn");
  await page.waitForSelector("#provider");

  // ── a faked review run that changes nothing: Post review as an issue ──
  await page.route("**/prompt", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessionId: "demo-review", status: "queued", repo: "https://github.com/demo/repo.git", provider: "deepseek", model: "deepseek-flash" }),
    }),
  );
  await page.route("**/events/demo-review/ticket", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "demo" }) }),
  );
  await page.route("**/issue/demo-review", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "https://github.com/demo/repo/issues/12" }) }),
  );
  await page.routeWebSocket(/\/events\/demo-review/, (ws) => {
    ws.send(JSON.stringify({ type: "hive_status", status: "running" }));
    ws.send(JSON.stringify({ type: "message_start", message: { role: "assistant" } }));
    ws.send(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Findings: all good." } }));
    ws.send(JSON.stringify({ type: "message_end", message: { role: "assistant" } }));
    ws.send(JSON.stringify({ type: "hive_done", status: "idle", commitsPushed: 0, repoSlug: "demo/repo", usage: { cost: 0.001 } }));
  });
  await page.reload();
  await page.waitForSelector("#provider");
  await page.fill("#task", "code review and next steps");
  await page.click("#startBtn");
  await page.waitForSelector("#postIssueBtn");
  assert((await page.$$("#openPrBtn")).length === 0, "a run with no changes offers no pull request");
  await page.click("#postIssueBtn");
  await page.waitForSelector("#issueLink");
  const issueHref = await page.$eval("#issueLink", (a) => a.getAttribute("href"));
  assert(issueHref === "https://github.com/demo/repo/issues/12", `View issue links to the issue (got ${issueHref})`);
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-review-issue.png") });
  await page.unroute("**/prompt");
  await page.unroute("**/events/demo-review/ticket");
  await page.unroute("**/issue/demo-review");
  await page.click("#newRunBtn");
  await page.waitForSelector("#provider");

  // ── desktop: the run list, switching runs, and reopening one from the URL ──
  const now = Date.now();
  const listA = {
    sessionId: "list-a",
    title: "Fix the login form",
    status: "running",
    repo: "https://github.com/demo/repo.git",
    model: "deepseek-flash",
    provider: "deepseek",
    createdAt: now - 60_000,
    lastActivity: now,
  };
  const listB = {
    sessionId: "list-b",
    title: "code review and next steps",
    status: "idle",
    repo: "https://github.com/demo/repo.git",
    model: "deepseek-flash",
    provider: "deepseek",
    createdAt: now - 600_000,
    lastActivity: now - 300_000,
    prUrl: "https://github.com/demo/repo/pull/9",
    stepStartedAt: now - 300_000,
    finishedAt: now - 240_000,
  };
  await page.route("**/runs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [listA, listB], capacity: { running: 1, queued: 0, max: 3 } }),
    }),
  );
  await page.route("**/status/list-b", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listB) }),
  );
  await page.route("**/events/list-b/ticket", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "demo" }) }),
  );
  await page.routeWebSocket(/\/events\/list-b/, (ws) => {
    ws.send(JSON.stringify({ type: "hive_status", status: "running" }));
    ws.send(
      JSON.stringify({
        type: "hive_done",
        status: "idle",
        resultBranch: "hive/listb000",
        commitsPushed: 1,
        repoSlug: "demo/repo",
        changes: { commits: ["Tidy the review flow"], files: [{ path: "src/review.ts", added: 4, removed: 2 }], moreFiles: 0 },
      }),
    );
  });

  // The WebSocket interception hook is an init script, so the document has to load after the
  // routes are registered. Reloading at #runs lands on the form with the mocked list next to it.
  await page.reload();
  await page.goto(`${BASE}/ui/#runs`);
  await page.waitForSelector("#newRunBtn");
  await page.waitForSelector(".run-item");
  const runTitles = await page.$$eval(".run-item", (nodes) =>
    nodes.map((node) => (node.querySelector(".run-item-title")?.textContent ?? "").trim()),
  );
  assert(runTitles.length === 2, `the run list shows two runs (got ${runTitles.length})`);
  assert(
    runTitles[0] === "Fix the login form",
    `the newest run comes first in the list (got ${JSON.stringify(runTitles[0])})`,
  );
  const listedHeaderBees = await page.$$eval(".header-bee", (nodes) => nodes.length);
  assert(listedHeaderBees === 1, `the header bee shows while a listed run is busy (got ${listedHeaderBees})`);

  await page.click('.run-item[href="#runs/list-b"]');
  await page.waitForSelector(".item-banner-ok");
  const beeTime = await page.$eval(".bee-time", (node) => (node.textContent ?? "").trim());
  assert(beeTime === "1:00", `the reopened run's bee shows its real duration (got ${JSON.stringify(beeTime)})`);
  const listHash = await page.evaluate(() => location.hash);
  assert(listHash === "#runs/list-b", `clicking a run sets its URL (got ${JSON.stringify(listHash)})`);
  const listDoneTitle = await page.$eval(".item-banner-ok .banner-title", (node) => (node.textContent ?? "").trim());
  assert(listDoneTitle === "Done", `the reopened run rebuilds its Done banner (got ${JSON.stringify(listDoneTitle)})`);
  await page.waitForSelector("#prLink");
  const restoredPrHref = await page.$eval("#prLink", (a) => a.getAttribute("href"));
  assert(
    restoredPrHref === "https://github.com/demo/repo/pull/9",
    `the pull request link is restored from the saved status (got ${restoredPrHref})`,
  );
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-runs-list.png") });

  await page.reload();
  await page.waitForSelector(".run-title");
  const reopenedTitle = await page.$eval(".run-title", (node) => (node.textContent ?? "").trim());
  assert(
    reopenedTitle === "code review and next steps",
    `a reload reopens the run from its URL (got ${JSON.stringify(reopenedTitle)})`,
  );
  await page.waitForSelector("#prLink");

  await page.unroute("**/runs");
  await page.unroute("**/status/list-b");
  await page.unroute("**/events/list-b/ticket");
  if (typeof page.unrouteWebSocket === "function") await page.unrouteWebSocket(/\/events\/list-b/);
  await page.goto(`${BASE}/ui/#runs`);
  await page.waitForSelector("#provider");

  // ── desktop: settings ──
  await page.click("#nav-settings");
  await page.waitForSelector("#keysTable tbody tr");
  const bodyRows = await page.$$eval("#keysTable tbody tr", (nodes) => nodes.length);
  assert(bodyRows === 5, `settings table has 5 body rows (got ${bodyRows})`);
  const defaultPills = await page.$$eval(".pill", (nodes) =>
    nodes.filter((node) => (node.textContent ?? "").trim() === "Default").length,
  );
  assert(defaultPills === 1, `settings table has one Default pill (got ${defaultPills})`);
  assert((await page.$$("#runSetupAgain")).length === 1, "settings links back to the setup flow");
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-settings.png") });

  const envRow = await page.$eval("#keysTable tbody", (tbody) => {
    const row = Array.from(tbody.querySelectorAll("tr")).find((node) =>
      (node.textContent ?? "").includes("DeepSeek"),
    );
    const remove = row?.querySelector('button[data-action="remove"]');
    return { text: row?.textContent ?? "", disabled: remove instanceof HTMLButtonElement ? remove.disabled : null };
  });
  assert(
    envRow.text.includes("From the environment (DEEPSEEK_API_KEY)"),
    `the DeepSeek row says the key comes from the environment (got ${JSON.stringify(envRow.text)})`,
  );
  assert(envRow.disabled === true, "Remove is disabled for a key that comes from the environment");

  // The add form posts the key once; mock the endpoint so no real provider is called.
  let keyPost = null;
  await page.route("**/api/keys", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    keyPost = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "zai",
        status: "works",
        detail: "The provider accepted the key",
        masked: "\u2026a1",
      }),
    });
  });
  await page.click("#addKeyBtn");
  await page.check('input[name="keyProvider"][value="zai"]');
  await page.fill("#newKey", "test-key-123456");
  await page.click("#saveKeyBtn");
  await page.waitForSelector("#addKeyForm", { state: "detached" });
  assert(keyPost !== null, "the add-key request body was captured");
  deepStrictEqual(keyPost, { provider: "zai", key: "test-key-123456" });
  await page.unroute("**/api/keys");
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-keys.png") });

  // ── desktop: settings > this computer ──
  await page.click("#settings-computer");
  await page.waitForSelector("#isolationCard");
  const checkRows = await page.$$eval("#checksTable tbody tr", (nodes) => nodes.length);
  assert(checkRows >= 2, `this computer lists its checks (got ${checkRows})`);
  await page.waitForSelector("#usageSection");
  await page.waitForFunction(() => document.querySelectorAll("#usageSection .usage-tile").length === 5, null, {
    timeout: 10_000,
  });
  const usageTiles = await page.$$eval("#usageSection .usage-tile", (nodes) => nodes.length);
  assert(usageTiles === 5, `the Right now section has five tiles (got ${usageTiles})`);
  const cpuValue = await page.$eval("#usageSection .usage-tile .usage-value", (node) => (node.textContent ?? "").trim());
  assert(/^\d+(\.\d)?%$/.test(cpuValue), `the CPU tile shows a percentage (got ${JSON.stringify(cpuValue)})`);
  await page.waitForSelector("#githubCard");
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-computer.png") });

  // ── theme toggle: light <-> dark, remembered; the user name is a tooltip on Log out ──
  const themeAttr = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
  assert((await themeAttr()) === null, "with no choice saved, the theme follows the device");
  await page.click("#themeBtn");
  assert((await themeAttr()) === "dark", "theme toggle switches to dark");
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(darkBg === "rgb(15, 17, 21)", `dark theme applies its background (got ${darkBg})`);
  await page.reload();
  await page.waitForSelector("#themeBtn");
  assert((await themeAttr()) === "dark", "the theme choice survives a reload");
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-dark.png") });
  await page.click("#themeBtn");
  assert((await themeAttr()) === "light", "theme toggle switches back to light");
  const logoutTitle = await page.getAttribute("#logoutBtn", "title");
  assert(
    logoutTitle === "Log out (current user: Admin)",
    `Log out shows the current user on hover (got ${logoutTitle})`,
  );
  assert((await page.$$(".user-name")).length === 0, "the user name is no longer in the header");

  // ── first-run onboarding (#setup): welcome -> checks -> key -> GitHub -> ready ──
  const onboarding = {
    needed: true,
    checks: [
      { name: "Hardware virtualization", id: "kvm", ok: true, detail: "/dev/kvm" },
      {
        name: "pasta (network isolation)",
        id: "pasta",
        ok: false,
        detail: "not found",
        fix: { text: "Install passt, which provides pasta.", command: "sudo dnf install passt" },
      },
    ],
    hasKey: false,
    defaultProvider: null,
    github: { connected: false },
    host: { distro: "fedora", wsl: false, bundle: true },
    rootfs: { ok: false, canDownload: true, download: { state: "idle", received: 0, total: undefined } },
  };
  await page.route("**/api/onboarding", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(onboarding) }),
  );
  await page.route("**/api/setup/rootfs", (route) =>
    route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ state: "downloading" }) }),
  );
  // A fresh browser: no token and no remembered setup, so signing in enters the setup flow.
  await page.evaluate(() => {
    localStorage.removeItem("hive-onboarding-done");
    localStorage.removeItem("hive_token");
  });
  await page.goto(`${BASE}/ui/`);
  await page.fill("#token", TOKEN);
  await page.click("#loginBtn");
  await page.waitForSelector("#onboarding");
  const welcomeTitle = await page.$eval("#onboarding .setup-step-body h1", (node) => (node.textContent ?? "").trim());
  assert(welcomeTitle === "Welcome to hive", `setup opens on the Welcome step (got ${JSON.stringify(welcomeTitle)})`);
  await page.click("#setup-next");
  await page.waitForSelector("#setup-checks");
  const failedFix = await page.$eval(".setup-check.is-failed .setup-command-text", (node) => (node.textContent ?? "").trim());
  assert(
    failedFix === "sudo dnf install passt",
    `the failed check shows its fix command (got ${JSON.stringify(failedFix)})`,
  );
  assert((await page.$$("#setup-download")).length === 1, "the Download VM filesystem button is offered");
  await page.click("#setup-download");
  await page.waitForSelector(".setup-progress");
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-onboarding-checks.png") });
  await page.click("#setup-next");
  await page.waitForSelector("#setup-provider");
  await page.click("#setup-next");
  await page.waitForSelector("#setup-github-check");
  await page.click("#setup-next");
  await page.waitForSelector("#setup-start-run");
  const summaryText = await page.$eval("#setup-summary", (node) => (node.textContent ?? "").trim());
  assert(summaryText.includes("checks passed"), `the Ready step summarizes the checks (got ${JSON.stringify(summaryText)})`);
  await page.click("#setup-start-run");
  await page.waitForSelector("#provider");
  const setupHash = await page.evaluate(() => location.hash);
  assert(setupHash === "#runs", `Start your first run lands on the Runs page (got ${JSON.stringify(setupHash)})`);
  const focusedId = await page.evaluate(() => document.activeElement?.id);
  assert(focusedId === "task", `Start your first run focuses the task box (got ${JSON.stringify(focusedId)})`);
  await page.unroute("**/api/onboarding");
  await page.unroute("**/api/setup/rootfs");

  // ── phone: runs view at 390 px ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/ui/#runs`);
  await page.waitForSelector("#provider");
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(scrollWidth <= 390, `no horizontal scroll at 390 px (scrollWidth ${scrollWidth})`);
  const headerHeight = await page.$eval(".header", (node) => node.getBoundingClientRect().height);
  assert(headerHeight <= 64, `header is at most 64 px tall at 390 px (got ${headerHeight})`);
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-phone.png") });

  console.log("ui-smoke: ok");
} catch (err) {
  exitCode = 1;
  console.error(`ui-smoke: FAIL ${err instanceof Error ? err.message : String(err)}`);
  if (serverLog) console.error(serverLog);
} finally {
  try {
    await browser?.close();
  } catch {}
  try {
    server.kill("SIGKILL");
  } catch {}
  rmSync(workspace, { recursive: true, force: true });
}
process.exit(exitCode);
