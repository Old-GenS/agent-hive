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
  assert(placeholder === "deepseek-v4-pro", `#model placeholder is deepseek-v4-pro (got ${JSON.stringify(placeholder)})`);

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

  demoSocket.send(JSON.stringify({ type: "hive_done", status: "idle", usage: { cost: 0.0123 } }));
  await page.waitForSelector('.bee-indicator[data-state="done"]');
  const stepsDone = await page.$$eval(".item-status[data-step]", (nodes) => nodes.map((n) => n.dataset.step));
  assert(
    JSON.stringify(stepsDone) === JSON.stringify(["done", "done"]),
    `every step is ticked off when the run is done (got ${JSON.stringify(stepsDone)})`,
  );
  const headerBeesDone = await page.$$eval(".header-bee", (nodes) => nodes.length);
  assert(headerBeesDone === 0, `header bee is removed when the run is done (got ${headerBeesDone})`);
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-run-done.png") });

  await page.emulateMedia({ reducedMotion: "reduce" });
  const beeAnimation = await page.evaluate(() => getComputedStyle(document.querySelector(".bee-flight")).animationName);
  assert(beeAnimation === "none", `reduced motion stops the bee flight (got ${beeAnimation})`);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.unroute("**/prompt");
  await page.unroute("**/events/demo-session/ticket");
  await page.click('button:has-text("New run")');
  await page.waitForSelector("#provider");

  // ── desktop: new-project form ──
  await page.click("#mode-new");
  assert(await page.isHidden("#repo"), "#repo is hidden in the new-project mode");
  assert(await page.isVisible("#newRepoName"), "#newRepoName is visible in the new-project mode");
  await page.fill("#newRepoName", "bad name");
  const startDisabled = await page.$eval("#startBtn", (node) => node.disabled);
  assert(startDisabled, "#startBtn is disabled while the project name is invalid");
  await page.fill("#newRepoName", "demo-project");
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
  const runMeta = await page.$eval(".run-meta", (node) => (node.textContent ?? "").trim());
  assert(
    runMeta.includes("new project demo-project"),
    `run meta says new project demo-project (got ${JSON.stringify(runMeta)})`,
  );
  await page.unroute("**/prompt");
  await page.unroute("**/events/demo-new/ticket");
  await page.click('button:has-text("New run")');
  await page.waitForSelector("#provider");

  // ── desktop: settings ──
  await page.click("#nav-settings");
  await page.waitForSelector("#settingsTable tbody tr");
  const bodyRows = await page.$$eval("#settingsTable tbody tr", (nodes) => nodes.length);
  assert(bodyRows === 5, `settings table has 5 body rows (got ${bodyRows})`);
  const defaultPills = await page.$$eval(".pill", (nodes) =>
    nodes.filter((node) => (node.textContent ?? "").trim() === "Default").length,
  );
  assert(defaultPills === 1, `settings table has one Default pill (got ${defaultPills})`);
  await page.screenshot({ path: join(repoRoot, ".handoff", "ui-settings.png") });

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
