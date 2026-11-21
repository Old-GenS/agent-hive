// Release install/update logic: version comparison, signature and checksum verification, atomic
// activation, rollback, prune and the once-a-day update notice. Everything (HOME, XDG dirs, the
// release API) is redirected to temp dirs and a local HTTP server before any dist module loads.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createServer } from "node:http";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "hive-release-test-"));
process.env.HOME = join(root, "home");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });

// No GitHub token: downloads must use the browser_download_url paths.
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.HIVE_BUNDLE_ROOT;
delete process.env.HIVE_NO_UPDATE_CHECK;

const { privateKey: testPrivateKey, publicKey: testPublicKey } = generateKeyPairSync("ed25519");
const publicKey = testPublicKey.export({ type: "spki", format: "pem" });
const { privateKey: otherPrivateKey } = generateKeyPairSync("ed25519");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Build the files of one release: the app bundle, its rootfs, a SHA256SUMS covering both and a
 * signature over the sums. `tamper: "app"` corrupts the app after signing, `tamper: "sig"` signs
 * the sums with a different key.
 */
function makeRelease(version, rver, { tamper } = {}) {
  const dir = mkdtempSync(join(root, "rel-"));
  const appDir = join(dir, `hive-${version}`);
  mkdirSync(join(appDir, "bin"), { recursive: true });
  writeFileSync(join(appDir, "VERSION"), `${version}\n`);
  writeFileSync(join(appDir, "ROOTFS_VERSION"), `${rver}\n`);
  writeFileSync(join(appDir, "bin", "hive"), "#!/bin/sh\necho hive\n", { mode: 0o755 });

  const appName = `hive-${version}-linux-x86_64.tar.gz`;
  execFileSync("tar", ["-czf", join(dir, appName), "-C", dir, `hive-${version}`]);

  let rootfsName;
  if (rver !== "none") {
    rootfsName = `hive-rootfs-${rver}-linux-x86_64.tar.gz`;
    const contents = join(dir, "rootfs-contents");
    mkdirSync(join(contents, "usr/local/bin"), { recursive: true });
    writeFileSync(join(contents, "usr/local/bin/hive-vm-init"), "");
    execFileSync("tar", ["-czf", join(dir, rootfsName), "-C", contents, "."]);
  }

  const names = rootfsName ? [appName, rootfsName] : [appName];
  const sums = names.map((name) => `${sha256(readFileSync(join(dir, name)))}  ${name}`).join("\n") + "\n";
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  const sigKey = tamper === "sig" ? otherPrivateKey : testPrivateKey;
  writeFileSync(join(dir, "SHA256SUMS.sig"), cryptoSign(null, Buffer.from(sums), sigKey).toString("base64") + "\n");

  if (tamper === "app") appendFileSync(join(dir, appName), "x");

  const files = new Map();
  for (const name of [...names, "SHA256SUMS", "SHA256SUMS.sig"]) {
    files.set(name, readFileSync(join(dir, name)));
  }
  return { version, files };
}

// The release the local API currently serves.
let current = null;
let baseUrl = "";
const requestCounts = new Map();

// Start the server. Bind :0 to pick a free ephemeral port, then re-bind that port by number:
// some sandboxed environments don't accept connections to a port that bind(0) handed out.
async function listenOnEphemeralPort(handler) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const srv = createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, "127.0.0.1", resolve);
      });
      return srv;
    } catch {
      srv.close();
    }
  }
  throw new Error("could not start the local release server");
}

const server = await listenOnEphemeralPort((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);

  if (current === null) {
    res.writeHead(404).end();
    return;
  }
  if (path === "/repos/o/r/releases/latest" || path === `/repos/o/r/releases/tags/v${current.version}`) {
    const assets = [...current.files.keys()].map((name) => ({
      name,
      url: `${baseUrl}/api/${name}`,
      browser_download_url: `${baseUrl}/dl/${name}`,
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tag_name: `v${current.version}`, assets }));
    return;
  }
  if (path.startsWith("/dl/")) {
    const body = current.files.get(decodeURIComponent(path.slice("/dl/".length)));
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
});

baseUrl = `http://127.0.0.1:${server.address().port}`;
process.env.HIVE_RELEASE_API = baseUrl;
process.env.HIVE_RELEASE_REPO = "o/r";

after(() => new Promise((resolve) => server.close(resolve)));

const release = await import("../dist/release.js");

const dataDir = join(process.env.XDG_DATA_HOME, "agent-hive");

test("compareVersions compares dotted numbers numerically", () => {
  assert.equal(release.compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(release.compareVersions("v1.2", "1.2.0"), 0);
  assert.equal(release.compareVersions("2.0.0", "1.9.9"), 1);
  assert.throws(() => release.compareVersions("1.x", "1.0.0"), /bad version: 1\.x/);
});

test("verifySums accepts only the right key and body", () => {
  const body = Buffer.from("hello\n");
  const good = cryptoSign(null, body, testPrivateKey).toString("base64");
  const wrong = cryptoSign(null, body, otherPrivateKey).toString("base64");
  assert.equal(release.verifySums(body, good, publicKey), true);
  assert.equal(release.verifySums(body, wrong, publicKey), false);
  assert.equal(release.verifySums(Buffer.from("hell0\n"), good, publicKey), false);
});

test("install 1.1.0 and activate it", async () => {
  current = makeRelease("1.1.0", "aaaaaaaaaaaa");
  const rel = await release.fetchRelease();
  const dir = await release.installRelease(rel, { publicKey });
  assert.equal(dir, join(dataDir, "versions/1.1.0"));

  release.activate("1.1.0");
  assert.ok(existsSync(join(dataDir, "versions/1.1.0/VERSION")));
  assert.ok(readlinkSync(release.currentLink()).endsWith("/versions/1.1.0"));
  assert.ok(existsSync(join(dataDir, "rootfs/aaaaaaaaaaaa/.complete")));
  assert.ok(lstatSync(join(process.env.HOME, ".local/bin/hive")).isSymbolicLink());
});

test("install 1.2.0 reuses the rootfs, then rollback swaps current and previous", async () => {
  current = makeRelease("1.2.0", "aaaaaaaaaaaa");
  const rootfsPath = "/dl/hive-rootfs-aaaaaaaaaaaa-linux-x86_64.tar.gz";
  assert.equal(requestCounts.get(rootfsPath), 1);

  const rel = await release.fetchRelease();
  await release.installRelease(rel, { publicKey });
  assert.equal(requestCounts.get(rootfsPath), 1);

  release.activate("1.2.0");
  assert.ok(readlinkSync(release.previousLink()).endsWith("/versions/1.1.0"));
  assert.ok(readlinkSync(release.currentLink()).endsWith("/versions/1.2.0"));

  assert.equal(release.rollback(), "1.1.0");
  assert.ok(readlinkSync(release.currentLink()).endsWith("/versions/1.1.0"));
  assert.ok(readlinkSync(release.previousLink()).endsWith("/versions/1.2.0"));
});

test("a tampered app tarball is rejected and current stays unchanged", async () => {
  current = makeRelease("1.3.0", "aaaaaaaaaaaa", { tamper: "app" });
  const before = readlinkSync(release.currentLink());
  await assert.rejects(release.installRelease(await release.fetchRelease(), { publicKey }), /checksum mismatch/);
  assert.equal(readlinkSync(release.currentLink()), before);
});

test("a signature from the wrong key is rejected", async () => {
  current = makeRelease("1.4.0", "aaaaaaaaaaaa", { tamper: "sig" });
  await assert.rejects(release.installRelease(await release.fetchRelease(), { publicKey }), /signature/);
});

test("an empty public key refuses to verify anything", async () => {
  current = makeRelease("1.5.0", "aaaaaaaaaaaa");
  await assert.rejects(release.installRelease(await release.fetchRelease(), { publicKey: "" }), /signing key/);
});

test("prune keeps the current and previous versions and their rootfs only", () => {
  mkdirSync(join(dataDir, "versions/0.9.0"), { recursive: true });
  mkdirSync(join(dataDir, "rootfs/bbbbbbbbbbbb"), { recursive: true });

  release.prune();

  assert.equal(existsSync(join(dataDir, "versions/0.9.0")), false);
  assert.ok(existsSync(join(dataDir, "versions/1.1.0")));
  assert.ok(existsSync(join(dataDir, "versions/1.2.0")));
  assert.equal(existsSync(join(dataDir, "rootfs/bbbbbbbbbbbb")), false);
  assert.ok(existsSync(join(dataDir, "rootfs/aaaaaaaaaaaa")));
});

test("updateNotice reports a newer version once a day, unless disabled", async () => {
  const bundle = mkdtempSync(join(root, "bundle-"));
  writeFileSync(join(bundle, "VERSION"), "1.1.0\n");
  process.env.HIVE_BUNDLE_ROOT = bundle;

  current = makeRelease("1.2.0", "aaaaaaaaaaaa");
  const latestPath = "/repos/o/r/releases/latest";
  const hits = requestCounts.get(latestPath) ?? 0;

  const notice = await release.updateNotice();
  assert.match(notice, /1\.2\.0/);
  assert.equal(requestCounts.get(latestPath), hits + 1);

  // The result was cached, so the second call must not hit the network again.
  assert.equal(await release.updateNotice(), notice);
  assert.equal(requestCounts.get(latestPath), hits + 1);

  process.env.HIVE_NO_UPDATE_CHECK = "1";
  assert.equal(await release.updateNotice(), undefined);
  delete process.env.HIVE_NO_UPDATE_CHECK;
  delete process.env.HIVE_BUNDLE_ROOT;
});

test("CLI update refuses to run outside an installed release", () => {
  delete process.env.HIVE_BUNDLE_ROOT;
  const result = spawnSync(process.execPath, ["dist/cli.js", "update"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runs from source/);
});

test("CLI doctor reports a source checkout", () => {
  delete process.env.HIVE_BUNDLE_ROOT;
  const result = spawnSync(process.execPath, ["dist/cli.js", "doctor"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.ok(result.stdout.startsWith("hive dev (from source)"));
});

test("CLI help lists the release commands", () => {
  const result = spawnSync(process.execPath, ["dist/cli.js", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.match(result.stdout, /hive update/);
});

test("uiDistCandidates tries HIVE_UI_DIR, the bundle, then the checkout", () => {
  const here = "/srv/hive/dist";
  const source = join("/srv/hive", "ui", "dist");
  assert.deepEqual(release.uiDistCandidates({}, here), [source]);
  assert.deepEqual(release.uiDistCandidates({ HIVE_UI_DIR: "/opt/ui" }, here), ["/opt/ui", source]);
  assert.deepEqual(release.uiDistCandidates({ HIVE_BUNDLE_ROOT: "/opt/hive" }, here), [
    join("/opt/hive", "ui", "dist"),
    source,
  ]);
  assert.deepEqual(release.uiDistCandidates({ HIVE_UI_DIR: "/opt/ui", HIVE_BUNDLE_ROOT: "/opt/hive" }, here), [
    "/opt/ui",
    join("/opt/hive", "ui", "dist"),
    source,
  ]);
});
