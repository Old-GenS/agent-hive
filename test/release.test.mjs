// Release install/update logic: version comparison, signature and checksum verification, atomic
// activation, rollback, prune and the once-a-day update notice. Everything (HOME, XDG dirs, the
// release API) is redirected to temp dirs and a local HTTP server before any dist module loads.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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

/**
 * The identity the release workflow's certificate names, and a stand-in verifier: the real one
 * checks a sigstore bundle against Fulcio and Rekor, so tests fake it with a JSON file instead.
 */
const TEST_IDENTITY = {
  issuer: "https://token.actions.githubusercontent.com",
  identity: "https://github.com/test/test/.github/workflows/promote.yml@refs/heads/main",
};
const OTHER_IDENTITY = {
  issuer: TEST_IDENTITY.issuer,
  identity: "https://example.invalid/other",
};
const fakeVerify = async (sums, bundleJson, identity) => {
  const b = JSON.parse(bundleJson);
  return b.sums === sha256(sums) && b.identity === identity.identity;
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Build the files of one release: the app bundle, its rootfs, a SHA256SUMS covering both and a
 * fake sigstore bundle over the sums. `image` ships the macOS arm64 disk image instead of the
 * Linux folder tarball (badMagic leaves the ext4 superblock out); `tamper: "app"` corrupts the app
 * after signing, `tamper: "sig"` names a different identity in the bundle.
 */
function makeRelease(version, rver, { tamper, image } = {}) {
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
    if (image) {
      rootfsName = `hive-rootfs-${rver}-linux-arm64.img.gz`;
      const disk = Buffer.alloc(4096);
      if (!image.badMagic) {
        disk[1080] = 0x53; // ext4 superblock magic, little-endian
        disk[1081] = 0xef;
      }
      writeFileSync(join(dir, rootfsName), gzipSync(disk));
    } else {
      rootfsName = `hive-rootfs-${rver}-linux-x86_64.tar.gz`;
      const contents = join(dir, "rootfs-contents");
      mkdirSync(join(contents, "usr/local/bin"), { recursive: true });
      writeFileSync(join(contents, "usr/local/bin/hive-vm-init"), "");
      execFileSync("tar", ["-czf", join(dir, rootfsName), "-C", contents, "."]);
    }
  }

  const names = rootfsName ? [appName, rootfsName] : [appName];
  const sums = names.map((name) => `${sha256(readFileSync(join(dir, name)))}  ${name}`).join("\n") + "\n";
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  const identity = tamper === "sig" ? OTHER_IDENTITY.identity : TEST_IDENTITY.identity;
  writeFileSync(
    join(dir, "SHA256SUMS.sigstore.json"),
    JSON.stringify({ sums: sha256(Buffer.from(sums)), identity }),
  );

  if (tamper === "app") appendFileSync(join(dir, appName), "x");

  const files = new Map();
  for (const name of [...names, "SHA256SUMS", "SHA256SUMS.sigstore.json"]) {
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

test("compareVersions orders prereleases below their release", () => {
  assert.equal(release.compareVersions("0.5.1-nightly.2", "0.5.1-nightly.10"), -1);
  assert.equal(release.compareVersions("0.5.1-nightly.10", "0.5.1"), -1);
  assert.equal(release.compareVersions("0.5.1", "0.5.1-nightly.10"), 1);
  assert.equal(release.compareVersions("0.5.0", "0.5.1-nightly.1"), -1);
  assert.equal(release.compareVersions("v0.5.1-nightly.3", "0.5.1-nightly.3"), 0);
  // The old dev and beta spellings are aliases: they still order, and mix with nightly by N.
  assert.equal(release.compareVersions("0.5.6-dev.3", "0.5.6-nightly.4"), -1);
  assert.equal(release.compareVersions("0.5.6-beta.3", "0.5.6-dev.4"), -1);
  assert.equal(release.compareVersions("0.5.6-dev.4", "0.5.6-beta.3"), 1);
  assert.equal(release.compareVersions("0.5.6-beta.3", "0.5.6-nightly.3"), 0);
  assert.throws(() => release.compareVersions("0.5.1-rc.1", "0.5.1"), /bad version: 0\.5\.1-rc\.1/);
  assert.equal(release.isPrerelease("0.5.1-nightly.2"), true);
  assert.equal(release.isPrerelease("v0.5.1-nightly.2"), true);
  assert.equal(release.isPrerelease("0.5.1-dev.2"), true);
  assert.equal(release.isPrerelease("0.5.1-beta.2"), true);
  assert.equal(release.isPrerelease("0.5.1"), false);
});


test("this build trusts only the promote workflow", () => {
  const identities = release.trustedIdentities();
  assert.equal(identities.length, 1);
  assert.equal(identities[0].issuer, "https://token.actions.githubusercontent.com");
  // Signing happens at promotion, so the certificate names promote.yml, not the build workflow.
  assert.match(identities[0].identity, /\.github\/workflows\/promote\.yml@refs\/heads\/main$/);
});

test("install 1.1.0 and activate it", async () => {
  current = makeRelease("1.1.0", "aaaaaaaaaaaa");
  const rel = await release.fetchRelease();
  const dir = await release.installRelease(rel, { identities: [TEST_IDENTITY], verify: fakeVerify, platform: "linux" });
  assert.equal(dir, join(dataDir, "versions/1.1.0"));

  release.activate("1.1.0");
  assert.ok(existsSync(join(dataDir, "versions/1.1.0/VERSION")));
  assert.ok(readlinkSync(release.currentLink()).endsWith("/versions/1.1.0"));
  assert.ok(existsSync(join(dataDir, "rootfs/aaaaaaaaaaaa/.complete")));
  assert.equal(
    readlinkSync(join(dataDir, "rootfs/current")),
    join(dataDir, "rootfs/aaaaaaaaaaaa"),
    "activation points the current rootfs link at the version's rootfs",
  );
  assert.ok(lstatSync(join(process.env.HOME, ".local/bin/hive")).isSymbolicLink());
});

test("install 1.2.0 reuses the rootfs, then rollback swaps current and previous", async () => {
  current = makeRelease("1.2.0", "aaaaaaaaaaaa");
  const rootfsPath = "/dl/hive-rootfs-aaaaaaaaaaaa-linux-x86_64.tar.gz";
  assert.equal(requestCounts.get(rootfsPath), 1);

  const rel = await release.fetchRelease();
  await release.installRelease(rel, { identities: [TEST_IDENTITY], verify: fakeVerify, platform: "linux" });
  assert.equal(requestCounts.get(rootfsPath), 1);

  release.activate("1.2.0");
  assert.ok(readlinkSync(release.previousLink()).endsWith("/versions/1.1.0"));
  assert.ok(readlinkSync(release.currentLink()).endsWith("/versions/1.2.0"));

  assert.equal(release.rollback(), "1.1.0");
  assert.ok(readlinkSync(release.currentLink()).endsWith("/versions/1.1.0"));
  assert.ok(readlinkSync(release.previousLink()).endsWith("/versions/1.2.0"));
});

test("the rootfs asset name depends on the platform", () => {
  assert.equal(
    release.rootfsAssetName("0123456789ab", "linux"),
    "hive-rootfs-0123456789ab-linux-x86_64.tar.gz",
  );
  assert.equal(
    release.rootfsAssetName("0123456789ab", "darwin"),
    "hive-rootfs-0123456789ab-linux-arm64.img.gz",
  );
});

test("isExt4Image reads the superblock magic", () => {
  const dir = mkdtempSync(join(root, "ext4-"));
  const good = join(dir, "good.img");
  const disk = Buffer.alloc(2048);
  disk[1080] = 0x53;
  disk[1081] = 0xef;
  writeFileSync(good, disk);
  const bad = join(dir, "bad.img");
  writeFileSync(bad, Buffer.alloc(2048));
  assert.equal(release.isExt4Image(good), true);
  assert.equal(release.isExt4Image(bad), false);
  assert.equal(release.isExt4Image(join(dir, "missing.img")), false);
});

test("ensureRootfs installs the macOS image and setupRootfs links current.img", async () => {
  const rver = "cafebabecafe";
  current = makeRelease("2.0.0", rver, { image: {} });
  const rel = await release.fetchRelease();
  const sums = release.parseSums(current.files.get("SHA256SUMS").toString("utf8"));
  const tmp = mkdtempSync(join(root, "image-dl-"));
  const name = release.rootfsAssetName(rver, "darwin");
  const hits = requestCounts.get("/dl/" + name) ?? 0;
  await release.ensureRootfs(rel, rver, sums, tmp, undefined, "darwin");
  const image = join(release.rootfsDir(), rver, "rootfs.img");
  assert.ok(existsSync(join(release.rootfsDir(), rver, ".complete")));
  assert.equal(release.isExt4Image(image), true);
  assert.equal(requestCounts.get("/dl/" + name), hits + 1);

  // The same rootfs, already installed, is linked without a second download.
  const bundle = mkdtempSync(join(root, "image-bundle-"));
  writeFileSync(join(bundle, "VERSION"), "2.0.0\n");
  writeFileSync(join(bundle, "ROOTFS_VERSION"), rver + "\n");
  process.env.HIVE_BUNDLE_ROOT = bundle;
  try {
    const path = await release.setupRootfs({ identities: [TEST_IDENTITY], verify: fakeVerify, platform: "darwin" });
    assert.equal(path, image);
    assert.equal(readlinkSync(release.rootfsCurrentLink("darwin")), image);
    assert.equal(requestCounts.get("/dl/" + name), hits + 1, "an installed image is not downloaded again");
  } finally {
    delete process.env.HIVE_BUNDLE_ROOT;
  }
});

test("ensureRootfs rejects a macOS image that is not ext4", async () => {
  const rver = "deadbeefcafe";
  current = makeRelease("2.1.0", rver, { image: { badMagic: true } });
  const rel = await release.fetchRelease();
  const sums = release.parseSums(current.files.get("SHA256SUMS").toString("utf8"));
  const tmp = mkdtempSync(join(root, "bad-image-"));
  await assert.rejects(
    () => release.ensureRootfs(rel, rver, sums, tmp, undefined, "darwin"),
    /not ext4/,
  );
  assert.equal(existsSync(join(release.rootfsDir(), rver)), false);
});

test("ensureRootfs names the missing asset for the platform", async () => {
  const rver = "abcdefabcdef";
  current = makeRelease("2.2.0", rver);
  const rel = await release.fetchRelease();
  const sums = release.parseSums(current.files.get("SHA256SUMS").toString("utf8"));
  const tmp = mkdtempSync(join(root, "no-image-"));
  await assert.rejects(
    () => release.ensureRootfs(rel, rver, sums, tmp, undefined, "darwin"),
    /no rootfs .*macOS.*linux-arm64\.img\.gz/,
  );
});

test("a tampered app tarball is rejected and current stays unchanged", async () => {
  current = makeRelease("1.3.0", "aaaaaaaaaaaa", { tamper: "app" });
  const before = readlinkSync(release.currentLink());
  await assert.rejects(release.installRelease(await release.fetchRelease(), { identities: [TEST_IDENTITY], verify: fakeVerify, platform: "linux" }), /checksum mismatch/);
  assert.equal(readlinkSync(release.currentLink()), before);
});

test("a bundle naming the wrong identity is rejected", async () => {
  current = makeRelease("1.4.0", "aaaaaaaaaaaa", { tamper: "sig" });
  await assert.rejects(release.installRelease(await release.fetchRelease(), { identities: [TEST_IDENTITY], verify: fakeVerify, platform: "linux" }), /signature/);
});

test("a release with only the old SHA256SUMS.sig is rejected as not signed keyless", async () => {
  current = makeRelease("1.4.1", "aaaaaaaaaaaa");
  // Serve the old ed25519 signature instead of the bundle, as a pre-keyless release did.
  current.files.delete("SHA256SUMS.sigstore.json");
  current.files.set("SHA256SUMS.sig", Buffer.from("b2xkIGVkMjU1MTkgc2lnbmF0dXJl\n"));
  await assert.rejects(
    release.installRelease(await release.fetchRelease(), { identities: [TEST_IDENTITY], verify: fakeVerify, platform: "linux" }),
    /not signed keyless/,
  );
});

test("no trusted signer refuses to verify anything", async () => {
  current = makeRelease("1.5.0", "aaaaaaaaaaaa");
  await assert.rejects(
    release.installRelease(await release.fetchRelease(), { identities: [], platform: "linux" }),
    /trusts no release signer/,
  );
});

test("a release signed by another identity installs only when that identity is trusted", async () => {
  current = makeRelease("1.6.0", "aaaaaaaaaaaa");
  const rel = await release.fetchRelease();
  await assert.rejects(release.installRelease(rel, { identities: [OTHER_IDENTITY], verify: fakeVerify, platform: "linux" }), /signature/);
  const dir = await release.installRelease(rel, { identities: [OTHER_IDENTITY, TEST_IDENTITY], verify: fakeVerify, platform: "linux" });
  assert.equal(dir, join(dataDir, "versions/1.6.0"));
  assert.ok(existsSync(join(dir, "VERSION")));
});

test("fetchRelease asks GitHub for the latest release", async () => {
  current = makeRelease("1.7.0", "aaaaaaaaaaaa");
  const latestPath = "/repos/o/r/releases/latest";
  const hits = requestCounts.get(latestPath) ?? 0;
  const rel = await release.fetchRelease();
  assert.equal(rel.version, "1.7.0");
  assert.equal(requestCounts.get(latestPath), hits + 1);
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


test("a bundle's rootfs path follows the release layout", () => {
  const bundle = mkdtempSync(join(root, "bundle-rootfs-"));
  const rver = "0123456789ab";
  writeFileSync(join(bundle, "VERSION"), "0.0.1\n");
  writeFileSync(join(bundle, "ROOTFS_VERSION"), rver + "\n");
  const data = mkdtempSync(join(root, "bundle-data-"));
  const dir = join(data, "agent-hive", "rootfs", rver);
  mkdirSync(dir, { recursive: true });
  let expected = dir;
  if (process.platform === "darwin") {
    expected = join(dir, "rootfs.img");
    writeFileSync(expected, "");
  } else {
    mkdirSync(join(dir, "usr/local/bin"), { recursive: true });
    writeFileSync(join(dir, "usr/local/bin/hive-vm-init"), "");
  }
  const env = {
    ...process.env,
    HIVE_BUNDLE_ROOT: bundle,
    XDG_DATA_HOME: data,
    HIVE_NO_UPDATE_CHECK: "1",
  };
  delete env.HIVE_ROOTFS;
  const result = spawnSync(process.execPath, [join(repoRoot, "dist/cli.js"), "doctor"], {
    env,
    encoding: "utf8",
  });
  assert.ok(result.stdout.includes("rootfs: ok"), result.stdout);
  assert.ok(result.stdout.includes(expected), result.stdout);
});

test("CLI doctor reports a source checkout", () => {
  delete process.env.HIVE_BUNDLE_ROOT;
  const result = spawnSync(process.execPath, ["dist/cli.js", "doctor"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.match(result.stdout, /^hive \d+\.\d+\.\d+ \(from source\)/);
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

test("fetchRelease with a tag asks for that tag", async () => {
  current = makeRelease("1.4.0", "aaaaaaaaaaaa", { image: {} });
  const rel = await release.fetchRelease(`v${current.version}`);
  assert.equal(rel.version, current.version);
  await assert.rejects(release.fetchRelease("v9.9.9"), /404/);
});
