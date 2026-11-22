// The install scripts: `sh -n install-cli.sh`, a full `install-cli.sh` run against a fake release
// served from localhost (no network, no sudo), and the static checks on install.ps1. The
// installer itself is only parsed and analysed in CI (.github/workflows/ci.yml).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installCli = join(repoRoot, "install-cli.sh");
const installPs1 = join(repoRoot, "install.ps1");
const root = mkdtempSync(join(tmpdir(), "hive-install-test-"));

const VERSION = "1.2.3";
const REPO = "o/r";
const APP = `hive-${VERSION}-linux-x86_64.tar.gz`;

// A tiny release: the app bundle (a hive that only succeeds and a VERSION file), its SHA256SUMS
// and the release JSON that points at them. All of it is served from 127.0.0.1.
const releaseDir = join(root, "release");
mkdirSync(join(releaseDir, `hive-${VERSION}`, "bin"), { recursive: true });
writeFileSync(join(releaseDir, `hive-${VERSION}`, "bin", "hive"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
writeFileSync(join(releaseDir, `hive-${VERSION}`, "VERSION"), `${VERSION}\n`);
const tarball = join(releaseDir, APP);
execFileSync("tar", ["-czf", tarball, "-C", releaseDir, `hive-${VERSION}`]);
const tarballBytes = readFileSync(tarball);
const sums = `${createHash("sha256").update(tarballBytes).digest("hex")}  ${APP}\n`;
writeFileSync(join(releaseDir, "SHA256SUMS"), sums);

// Some sandboxed environments refuse connections to a port that bind(0) handed out, so find a
// free port by number first and listen on that (the same workaround as test/egress.test.mjs).
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
  if (path === `/repos/${REPO}/releases/latest`) {
    const body = JSON.stringify({
      tag_name: `v${VERSION}`,
      assets: [
        { name: "SHA256SUMS", browser_download_url: `${baseUrl}/SHA256SUMS` },
        { name: APP, browser_download_url: `${baseUrl}/${APP}` },
      ],
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }
  if (path === "/SHA256SUMS") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(sums);
    return;
  }
  if (path === `/${APP}`) {
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(tarballBytes);
    return;
  }
  res.writeHead(404);
  res.end();
});
baseUrl = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

/** A HOME and XDG_DATA_HOME under the test root, and an environment for install-cli.sh. */
function installEnv(name, extra = {}) {
  const home = join(root, name);
  const data = join(root, `${name}-data`);
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  const path = (process.env.PATH ?? "/usr/bin:/bin")
    .split(":")
    .filter((part) => part && part !== join(home, ".local", "bin"))
    .join(":");
  return {
    home,
    data,
    env: {
      HOME: home,
      XDG_DATA_HOME: data,
      PATH: path,
      HIVE_RELEASE_API: baseUrl,
      HIVE_RELEASE_REPO: REPO,
      HIVE_INSTALL_SKIP_SETUP: "1",
      ...extra,
    },
  };
}

// Asynchronous on purpose: the fake release server lives in this process, and spawnSync would
// block its event loop so the curl inside the script could never get a response.
const execFileAsync = promisify(execFile);

async function runInstall(env) {
  try {
    const { stdout, stderr } = await execFileAsync("sh", [installCli], { cwd: repoRoot, env, encoding: "utf8" });
    return { status: 0, stdout, stderr };
  } catch (err) {
    return { status: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
  }
}

function countPathLine(home) {
  const profile = join(home, ".profile");
  if (!existsSync(profile)) return 0;
  return readFileSync(profile, "utf8").split("\n").filter((line) => line.includes("added by agent-hive")).length;
}

test("install-cli.sh parses with sh -n", () => {
  const result = spawnSync("sh", ["-n", installCli], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("install-cli.sh installs the fake release and adds ~/.local/bin to PATH once", async () => {
  const { home, data, env } = installEnv("home-one");
  const first = await runInstall(env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`hive ${VERSION} installed`));
  assert.match(first.stdout, /next: hive doctor/);

  const link = join(home, ".local", "bin", "hive");
  assert.ok(lstatSync(link).isSymbolicLink(), "~/.local/bin/hive is a symlink");
  assert.equal(readlinkSync(link), join(data, "agent-hive", "current", "bin", "hive"));
  assert.ok(existsSync(join(data, "agent-hive", "versions", VERSION, "bin", "hive")));
  assert.equal(countPathLine(home), 1, "~/.profile gained the PATH line once");

  const second = await runInstall(env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(countPathLine(home), 1, "a second install does not add the PATH line again");
});

test("install-cli.sh leaves ~/.profile alone with HIVE_NO_MODIFY_PATH=1", async () => {
  const { home, env } = installEnv("home-two", { HIVE_NO_MODIFY_PATH: "1" });
  const result = await runInstall(env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(join(home, ".profile")), "no ~/.profile is written");
  assert.match(result.stdout, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
});

test("install.ps1 has the Windows installer's pieces", () => {
  const text = readFileSync(installPs1, "utf8");
  for (const needle of ["Set-StrictMode", "--no-launch", "chpasswd", "nestedVirtualization", "--unregister", "HIVE_WSL_DISTRO"]) {
    assert.ok(text.includes(needle), `install.ps1 contains ${needle}`);
  }
});

test("install.ps1 sends the Linux password to chpasswd over stdin", () => {
  const line = readFileSync(installPs1, "utf8")
    .split("\n")
    .find((candidate) => candidate.includes("chpasswd"));
  assert.ok(line, "install.ps1 runs chpasswd");
  assert.match(line, /\|\s*wsl\.exe\b/, "chpasswd is fed by a pipeline into wsl.exe");
});
