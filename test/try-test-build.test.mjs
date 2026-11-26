// scripts/try-test-build.sh: its bash syntax check and full runs against a fake release API
// served from 127.0.0.1 (no network). The script is Linux x86_64 only, so the execution tests are
// skipped elsewhere. Like test/install-scripts.test.mjs, the runs are asynchronous: the fake
// server lives in this process, and a blocking spawnSync would stop it answering the script's
// curl.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repoRoot, "scripts", "try-test-build.sh");
const root = mkdtempSync(join(tmpdir(), "hive-try-test-build-"));

const SUPPORTED = process.platform === "linux" && process.arch === "x64";
const SKIP = !SUPPORTED && "scripts/try-test-build.sh only runs on Linux x86_64";

const REPO = "o/r";
const ROOTFS_ID = "aaaaaaaaaaaa";
const ROOTFS_NAME = `hive-rootfs-${ROOTFS_ID}-linux-x86_64.tar.gz`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The fake release: the app bundle, one VM filesystem, each build's SHA256SUMS and the release
// JSON that points at them. `releases` is mutable so the checksum-mismatch test can add a build
// only after the newest-build test has run.
const releases = [];
const assets = new Map();
const requests = new Map();

function resetRequests() {
  requests.clear();
}

function requestCount(path) {
  return requests.get(path) ?? 0;
}

// The VM filesystem, shared by every test build (a real one is named by its content).
function defaultHiveScript() {
  return (
    '#!/bin/sh\n' +
    'echo "ran $HIVE_ROOTFS $*${PORT:+ port=$PORT}${HOST:+ host=$HOST}${HIVE_BUILD_CHANNEL:+ channel=$HIVE_BUILD_CHANNEL}${XDG_CONFIG_HOME:+ config=$XDG_CONFIG_HOME}"\n'
  );
}

const rootfsSource = join(root, "rootfs-source");
mkdirSync(join(rootfsSource, "etc"), { recursive: true });
writeFileSync(join(rootfsSource, "etc", "os-release"), "ID=test\n");
const rootfsFile = join(root, ROOTFS_NAME);
execFileSync("tar", ["-czf", rootfsFile, "-C", rootfsSource, "."]);
const rootfsBytes = readFileSync(rootfsFile);

function makeApp(version, hiveScript = defaultHiveScript()) {
  const dir = mkdtempSync(join(root, "app-"));
  const appDir = join(dir, `hive-${version}`);
  mkdirSync(join(appDir, "bin"), { recursive: true });
  writeFileSync(join(appDir, "bin", "hive"), hiveScript, { mode: 0o755 });
  writeFileSync(join(appDir, "VERSION"), `${version}\n`);
  writeFileSync(join(appDir, "ROOTFS_VERSION"), `${ROOTFS_ID}\n`);
  const name = `hive-${version}-linux-x86_64.tar.gz`;
  execFileSync("tar", ["-czf", join(dir, name), "-C", dir, `hive-${version}`]);
  return { name, bytes: readFileSync(join(dir, name)) };
}

function addBuild(tag, version, createdAt, { wrongAppHash = false, hiveScript } = {}) {
  const app = makeApp(version, hiveScript);
  const appPath = `/assets/${tag}/${app.name}`;
  const rootfsPath = `/assets/${tag}/${ROOTFS_NAME}`;
  const sumsPath = `/assets/${tag}/SHA256SUMS`;
  const appHash = wrongAppHash ? sha256(Buffer.from("not the app")) : sha256(app.bytes);
  const sums = `${appHash}  ${app.name}\n${sha256(rootfsBytes)}  ${ROOTFS_NAME}\n`;
  assets.set(appPath, app.bytes);
  assets.set(rootfsPath, rootfsBytes);
  assets.set(sumsPath, Buffer.from(sums));
  releases.push({
    tag_name: tag,
    created_at: createdAt,
    target_commitish: `commit-${version}`,
    assets: [
      { name: app.name, browser_download_url: `${baseUrl}${appPath}`, size: app.bytes.length },
      { name: ROOTFS_NAME, browser_download_url: `${baseUrl}${rootfsPath}`, size: rootfsBytes.length },
      { name: "SHA256SUMS", browser_download_url: `${baseUrl}${sumsPath}`, size: sums.length },
    ],
  });
}

// Some sandboxed environments refuse connections to a port that bind(0) handed out, so find a
// free port by number first and listen on that (the same workaround as test/install-scripts.test.mjs).
async function listen(handler) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const server = createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return server;
    } catch {
      server.close();
    }
  }
  throw new Error("could not start the fake release server");
}

let baseUrl = "";
const server = await listen((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  if (path === `/repos/${REPO}/releases`) {
    const body = JSON.stringify(releases.map(({ tag_name, created_at }) => ({ tag_name, created_at })));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }
  const tagPrefix = `/repos/${REPO}/releases/tags/`;
  if (path.startsWith(tagPrefix)) {
    const tag = decodeURIComponent(path.slice(tagPrefix.length));
    const release = releases.find((candidate) => candidate.tag_name === tag);
    if (!release) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(release));
    return;
  }
  const bytes = assets.get(path);
  if (bytes) {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(bytes);
    return;
  }
  res.writeHead(404);
  res.end();
});
baseUrl = `http://127.0.0.1:${server.address().port}`;

releases.push({ tag_name: "v1.2.2", created_at: "2025-12-01T00:00:00Z", target_commitish: "stable", assets: [] });
addBuild("test-3-1.2.3", "1.2.3", "2026-01-01T00:00:00Z");
addBuild("test-4-1.2.4", "1.2.4", "2026-01-02T00:00:00Z");
// A build whose hive just prints its environment: the --serve test uses it to prove no key from
// the calling shell reaches the server. An old created_at keeps it out of the newest-build tests.
addBuild("test-6-1.2.6", "1.2.6", "2025-11-01T00:00:00Z", { hiveScript: "#!/bin/sh\nenv\n" });

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const execFileAsync = promisify(execFile);

function scriptEnv({ cache, data = join(root, "data"), extra = {} }) {
  return {
    HOME: join(root, "home"),
    XDG_DATA_HOME: data,
    HIVE_RELEASE_API: baseUrl,
    HIVE_RELEASE_REPO: REPO,
    HIVE_TEST_BUILDS: cache,
    HIVE_TEST_BUILDS_MIN_FREE_MB: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...extra,
  };
}

async function runScript(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [script, ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr };
  } catch (err) {
    return { status: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
  }
}

/** A port that is free right now: let bind(0) pick one, then release it. */
async function freePortNumber() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = createNetServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    if (port > 0) return port;
  }
  throw new Error("could not find a free port");
}

/** Hold a port with a listening socket, and check that `port + 1` can be bound too. */
async function holdPortWithNextFree() {
  for (let attempt = 0; attempt < 25; attempt++) {
    const port = await freePortNumber();
    if (port >= 65535) continue;
    const holder = createNetServer();
    try {
      await new Promise((resolve, reject) => {
        holder.once("error", reject);
        holder.listen(port, "127.0.0.1", resolve);
      });
    } catch {
      holder.close();
      continue;
    }
    const next = createNetServer();
    try {
      await new Promise((resolve, reject) => {
        next.once("error", reject);
        next.listen(port + 1, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => next.close(resolve));
      return { port, holder };
    } catch {
      next.close();
      await new Promise((resolve) => holder.close(resolve));
    }
  }
  throw new Error("could not find two free ports next to each other");
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

/** Any download directory or half-extracted VM filesystem left behind under `dir`. */
function leftovers(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".dl.") || entry.name.endsWith(".partial")) found.push(join(current, entry.name));
      if (entry.isDirectory()) walk(join(current, entry.name));
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

test("try-test-build.sh parses with bash -n", () => {
  const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("try-test-build.sh downloads the newest test build and its VM filesystem", { skip: SKIP }, async () => {
  const cache = join(root, "cache");
  resetRequests();
  const result = await runScript([], scriptEnv({ cache }));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(cache, "test-4-1.2.4", "hive-1.2.4", "VERSION")));
  assert.ok(existsSync(join(cache, "rootfs", ROOTFS_ID, ".complete")));
  assert.match(result.stdout, /test build: test-4-1\.2\.4/);
  assert.match(result.stdout, /\(downloaded\)/);
  assert.ok(result.stdout.includes(`HIVE_ROOTFS=${join(cache, "rootfs", ROOTFS_ID)}`), result.stdout);
  assert.deepEqual(leftovers(cache), []);
  assert.equal(requestCount(`/assets/test-4-1.2.4/hive-1.2.4-linux-x86_64.tar.gz`), 1);
  assert.equal(requestCount(`/assets/test-4-1.2.4/${ROOTFS_NAME}`), 1);
});

test("try-test-build.sh reuses the cached bundle and VM filesystem", { skip: SKIP }, async () => {
  const cache = join(root, "cache");
  resetRequests();
  const result = await runScript(["test-4-1.2.4"], scriptEnv({ cache }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(cached\)/);
  assert.equal(requestCount(`/assets/test-4-1.2.4/hive-1.2.4-linux-x86_64.tar.gz`), 0);
  assert.equal(requestCount(`/assets/test-4-1.2.4/${ROOTFS_NAME}`), 0);
});

test("try-test-build.sh reuses a VM filesystem from the hive install", { skip: SKIP }, async () => {
  const cache = join(root, "cache-independent");
  const installed = join(root, "data", "agent-hive", "rootfs", ROOTFS_ID);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, ".complete"), "");
  resetRequests();
  const result = await runScript(["test-3-1.2.3"], scriptEnv({ cache }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(from your hive install\)/);
  assert.ok(result.stdout.includes(`HIVE_ROOTFS=${installed}`), result.stdout);
  assert.equal(requestCount(`/assets/test-3-1.2.3/${ROOTFS_NAME}`), 0);
});

test("try-test-build.sh rejects a bad checksum and keeps nothing", { skip: SKIP }, async () => {
  addBuild("test-5-1.2.5", "1.2.5", "2026-01-03T00:00:00Z", { wrongAppHash: true });
  const cache = join(root, "cache");
  const result = await runScript(["test-5-1.2.5"], scriptEnv({ cache }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  assert.ok(!existsSync(join(cache, "test-5-1.2.5", "hive-1.2.5")));
});

test("try-test-build.sh rejects a non-test-build tag before any request", { skip: SKIP }, async () => {
  resetRequests();
  const result = await runScript(["v1.2.2"], scriptEnv({ cache: join(root, "cache") }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /is not a test build tag/);
  assert.equal(requests.size, 0);
});

test("try-test-build.sh runs the test build with --", { skip: SKIP }, async () => {
  const cache = join(root, "cache");
  // No installed filesystem here: this test expects the cached one under $HIVE_TEST_BUILDS.
  const result = await runScript(
    ["test-4-1.2.4", "--", "run", "hello"],
    scriptEnv({ cache, data: join(root, "data-empty") }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `ran ${join(cache, "rootfs", ROOTFS_ID)} run hello\n`);
  assert.match(result.stderr, /test build: test-4-1\.2\.4/);
});

test("try-test-build.sh --list lists test builds newest first and marks cached ones", { skip: SKIP }, async () => {
  const result = await runScript(["--list"], scriptEnv({ cache: join(root, "cache") }));
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.ok(lines[0].startsWith("test-5-1.2.5"), result.stdout);
  assert.ok(lines[1].startsWith("test-4-1.2.4"), result.stdout);
  assert.ok(lines[2].startsWith("test-3-1.2.3"), result.stdout);
  const cached = lines.find((line) => line.startsWith("test-4-1.2.4"));
  assert.ok(cached.endsWith("(cached)"), cached);
  assert.ok(!result.stdout.includes("v1.2.2"));
});

test("try-test-build.sh --clean removes the cache", { skip: SKIP }, async () => {
  const cache = join(root, "cache");
  const result = await runScript(["--clean"], scriptEnv({ cache }));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(cache));
});

test("try-test-build.sh --serve runs the server in its own home", { skip: SKIP }, async () => {
  const cache = join(root, "cache-serve");
  const serveHome = join(root, "serve-home");
  const port = await freePortNumber();
  const result = await runScript(
    ["test-4-1.2.4", "--serve", "--port", String(port)],
    scriptEnv({ cache, data: join(root, "data-serve"), extra: { HIVE_TEST_SERVE_HOME: serveHome } }),
  );
  assert.equal(result.status, 0, result.stderr);
  const rootfs = join(cache, "rootfs", ROOTFS_ID);
  assert.equal(
    result.stdout,
    `ran ${rootfs} serve port=${port} host=127.0.0.1 channel=test config=${join(serveHome, "config")}\n`,
  );
  assert.match(result.stderr, new RegExp(`serving test-4-1\\.2\\.4 on http://127\\.0\\.0\\.1:${port}/ui/`));
  assert.ok(result.stderr.includes(`isolated home: ${serveHome}`), result.stderr);
  assert.ok(
    result.stderr.includes(`log in with API_TOKEN from ${join(serveHome, "config", "agent-hive", "env")}`),
    result.stderr,
  );
  assert.equal(readFileSync(join(serveHome, "current"), "utf8"), "test-4-1.2.4\n");
  for (const dir of ["config", "data", "cache"]) {
    assert.ok(existsSync(join(serveHome, dir)), dir);
  }
});

test("try-test-build.sh --serve --port refuses a port that is in use", { skip: SKIP }, async () => {
  const { port, holder } = await holdPortWithNextFree();
  try {
    const result = await runScript(
      ["--serve", "--port", String(port)],
      scriptEnv({
        cache: join(root, "cache-serve"),
        data: join(root, "data-serve"),
        extra: { HIVE_TEST_SERVE_HOME: join(root, "serve-busy") },
      }),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`port ${port} is in use`));
  } finally {
    await closeServer(holder);
  }
});

test("try-test-build.sh --serve takes the next free port from HIVE_TEST_SERVE_PORT", { skip: SKIP }, async () => {
  const { port, holder } = await holdPortWithNextFree();
  try {
    const result = await runScript(
      ["test-4-1.2.4", "--serve"],
      scriptEnv({
        cache: join(root, "cache-serve"),
        data: join(root, "data-serve"),
        extra: { HIVE_TEST_SERVE_HOME: join(root, "serve-port"), HIVE_TEST_SERVE_PORT: String(port) },
      }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`port=${port + 1}\\b`));
  } finally {
    await closeServer(holder);
  }
});

test("try-test-build.sh --serve --fresh removes the serve home first", { skip: SKIP }, async () => {
  const serveHome = join(root, "serve-fresh");
  mkdirSync(serveHome, { recursive: true });
  writeFileSync(join(serveHome, "marker"), "old\n");
  const port = await freePortNumber();
  const result = await runScript(
    ["test-4-1.2.4", "--serve", "--port", String(port), "--fresh"],
    scriptEnv({ cache: join(root, "cache-serve"), data: join(root, "data-serve"), extra: { HIVE_TEST_SERVE_HOME: serveHome } }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(join(serveHome, "marker")));
  assert.ok(existsSync(join(serveHome, "current")));
});

test("try-test-build.sh --serve is incompatible with --", { skip: SKIP }, async () => {
  const result = await runScript(["--serve", "--", "run"], scriptEnv({ cache: join(root, "cache-serve") }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test("try-test-build.sh --serve falls back to the cached build when GitHub is unreachable", { skip: SKIP }, async () => {
  const cache = join(root, "cache-offline");
  const warm = await runScript(["test-4-1.2.4"], scriptEnv({ cache, data: join(root, "data-offline") }));
  assert.equal(warm.status, 0, warm.stderr);
  const serveHome = join(root, "serve-offline");
  mkdirSync(serveHome, { recursive: true });
  writeFileSync(join(serveHome, "current"), "test-4-1.2.4\n");
  const closed = await freePortNumber();
  const port = await freePortNumber();
  const result = await runScript(
    ["--serve", "--port", String(port)],
    scriptEnv({
      cache,
      data: join(root, "data-offline"),
      extra: { HIVE_TEST_SERVE_HOME: serveHome, HIVE_RELEASE_API: `http://127.0.0.1:${closed}` },
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /GitHub unreachable; serving cached test-4-1\.2\.4/);
  assert.equal(
    result.stdout,
    `ran ${join(cache, "rootfs", ROOTFS_ID)} serve port=${port} host=127.0.0.1 channel=test config=${join(serveHome, "config")}\n`,
  );
});

test("try-test-build.sh --serve passes none of the calling shell's environment", { skip: SKIP }, async () => {
  const port = await freePortNumber();
  const result = await runScript(
    ["test-6-1.2.6", "--serve", "--port", String(port)],
    scriptEnv({
      cache: join(root, "cache-env"),
      data: join(root, "data-env"),
      extra: { HIVE_TEST_SERVE_HOME: join(root, "serve-env"), DEEPSEEK_API_KEY: "leak", GITHUB_TOKEN: "leak" },
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("leak"), result.stdout);
  assert.match(result.stdout, /^HIVE_BUILD_CHANNEL=test$/m);
  assert.match(result.stdout, /^PORT=\d+$/m);
  assert.match(result.stdout, /^XDG_CONFIG_HOME=.*\/serve-env\/config$/m);
});
