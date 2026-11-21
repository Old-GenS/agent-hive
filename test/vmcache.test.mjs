// Per-repo VM cache buckets: the identity a repo maps to, the bucket it mounts, and pruning old
// buckets (with the old flat cache removed first). No VM is booted.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed before any dist/ import: config.ts reads them at import time.
const root = mkdtempSync(join(tmpdir(), "hive-vmcache-"));
const cacheRoot = join(root, "vm-cache");
process.env.HIVE_VM_CACHE = cacheRoot;
process.env.HIVE_RUNS_DIR = join(root, "runs");
process.env.HIVE_DOTENV_PATH = join(root, "missing.env");
process.env.HIVE_KEYS_FILE = join(root, "missing-keys");
delete process.env.HIVE_VM_CACHE_DAYS;

const { cacheKey, cacheBucket, useCacheBucket, pruneVmCache } = await import("../dist/vmcache.js");

const DAY = 86_400_000;
const remote = (repo) => ({ source: "remote", repo });
const local = (repo) => ({ source: "local", repo });
const project = (name) => ({ source: "new", repo: "", newRepo: { name, private: true } });

/** An empty cache root; tests build the legacy entries and repos/ buckets they need. */
function resetCache() {
  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(cacheRoot, { recursive: true });
}

/** A bucket directory plus a `.used` marker `ageDays` old (0 = now). */
function makeBucket(key, ageDays = 0) {
  const repos = join(cacheRoot, "repos");
  mkdirSync(join(repos, key), { recursive: true });
  writeFileSync(join(repos, key, "file"), "x");
  const marker = join(repos, key + ".used");
  writeFileSync(marker, "");
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * DAY);
    utimesSync(marker, when, when);
  }
  return join(repos, key);
}

after(() => rmSync(root, { recursive: true, force: true }));

test("cacheKey is the same for every form of a github.com repo", () => {
  const key = cacheKey(remote("https://github.com/O/N.git"));
  assert.equal(key, cacheKey(remote("https://github.com/o/n")));
  assert.equal(key, cacheKey(remote("git@github.com:o/n")));
  assert.equal(key, cacheKey(remote("git@github.com:o/n.git")));
  assert.equal(key, cacheKey(remote("ssh://git@github.com/o/n")));
  assert.equal(key, cacheKey(remote("ssh://git@github.com/o/n.git")));
});

test("cacheKey differs between repos, sources and local paths", () => {
  const a = cacheKey(remote("https://github.com/me/a"));
  const b = cacheKey(remote("https://github.com/me/b"));
  assert.notEqual(a, b);
  // Two local checkouts at different paths are different repos.
  const one = join(root, "one");
  const two = join(root, "two");
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  assert.equal(cacheKey(local(one)), cacheKey(local(one + "/")));
  assert.notEqual(cacheKey(local(one)), cacheKey(local(two)));
  // A new project is not the remote repo of the same name.
  assert.notEqual(cacheKey(project("demo")), cacheKey(remote("https://github.com/me/demo")));
  // A non-github URL is normalised too: case, a trailing slash and `.git` don't matter.
  assert.equal(
    cacheKey(remote("https://git.example.com/me/Demo.git/")),
    cacheKey(remote("https://git.example.com/me/demo")),
  );
});

test("keys are 16 hex characters", () => {
  assert.match(cacheKey(remote("https://github.com/me/a")), /^[0-9a-f]{16}$/);
  assert.match(cacheKey(project("Demo")), /^[0-9a-f]{16}$/);
});

test("useCacheBucket creates the bucket and its marker, per repo", () => {
  resetCache();
  const a = remote("https://github.com/me/a");
  const b = remote("https://github.com/me/b");
  const bucketA = useCacheBucket(a);
  const keyA = cacheKey(a);
  assert.equal(bucketA, join(cacheRoot, "repos", keyA));
  assert.equal(lstatSync(bucketA).isDirectory(), true);
  assert.equal(existsSync(join(cacheRoot, "repos", keyA + ".used")), true);
  // The marker is next to the bucket, not inside it.
  assert.equal(existsSync(join(bucketA, keyA + ".used")), false);
  assert.equal(existsSync(join(cacheRoot, "repos", cacheKey(b))), false);
  assert.notEqual(useCacheBucket(b), bucketA);
});

test("cacheBucket returns undefined when the VM cache is disabled", () => {
  // config.ts reads HIVE_VM_CACHE at import time, so the disabled case needs its own process.
  const url = new URL("../dist/vmcache.js", import.meta.url).href;
  const probe = `const { cacheBucket } = await import(${JSON.stringify(url)});
process.stdout.write(JSON.stringify({ bucket: cacheBucket({ source: "remote", repo: "https://github.com/me/a" }) }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, HIVE_VM_CACHE: "", HIVE_DOTENV_PATH: join(root, "missing.env") },
  });
  assert.equal(JSON.parse(out).bucket, undefined);
});

test("pruneVmCache deletes the old flat cache and everything but repos", () => {
  resetCache();
  mkdirSync(join(cacheRoot, "npm"), { recursive: true });
  writeFileSync(join(cacheRoot, "npm", "cache.tgz"), "x");
  writeFileSync(join(cacheRoot, "old-file"), "x");
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "keep me");
  symlinkSync(outside, join(cacheRoot, "legacy-link"));

  assert.deepEqual(pruneVmCache(new Set()), []);
  assert.equal(existsSync(join(cacheRoot, "npm")), false);
  assert.equal(existsSync(join(cacheRoot, "old-file")), false);
  assert.equal(lstatSync(join(cacheRoot, "legacy-link"), { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(outside, "utf8"), "keep me");
});

test("pruneVmCache deletes old buckets with their markers and keeps fresh ones", () => {
  resetCache();
  const oldKey = "aaaaaaaaaaaaaaaa";
  const freshKey = "bbbbbbbbbbbbbbbb";
  const oldBucket = makeBucket(oldKey, 31);
  const freshBucket = makeBucket(freshKey, 1);

  assert.deepEqual(pruneVmCache(new Set()), [oldKey]);
  assert.equal(existsSync(oldBucket), false);
  assert.equal(existsSync(join(cacheRoot, "repos", oldKey + ".used")), false);
  assert.equal(existsSync(freshBucket), true);
  assert.equal(existsSync(join(cacheRoot, "repos", freshKey + ".used")), true);
});

test("pruneVmCache keeps an old bucket that a live run uses", () => {
  resetCache();
  const key = "cccccccccccccccc";
  const bucket = makeBucket(key, 40);
  assert.deepEqual(pruneVmCache(new Set([key])), []);
  assert.equal(existsSync(bucket), true);
  assert.equal(existsSync(join(cacheRoot, "repos", key + ".used")), true);
});

test("pruneVmCache deletes a bucket whose marker is missing", () => {
  resetCache();
  const key = "dddddddddddddddd";
  const bucket = join(cacheRoot, "repos", key);
  mkdirSync(bucket, { recursive: true });
  assert.deepEqual(pruneVmCache(new Set()), [key]);
  assert.equal(existsSync(bucket), false);
});

test("pruneVmCache removes a symlink in repos/ without following it", () => {
  resetCache();
  const outside = join(root, "outside-folder");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "precious"), "keep me");
  const link = join(cacheRoot, "repos", "eeeeeeeeeeeeeeee");
  mkdirSync(join(cacheRoot, "repos"), { recursive: true });
  symlinkSync(outside, link);

  pruneVmCache(new Set());
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(join(outside, "precious"), "utf8"), "keep me");
});

test("pruneVmCache drops markers whose bucket is gone", () => {
  resetCache();
  const marker = join(cacheRoot, "repos", "ffffffffffffffff.used");
  mkdirSync(join(cacheRoot, "repos"), { recursive: true });
  writeFileSync(marker, "");
  pruneVmCache(new Set());
  assert.equal(existsSync(marker), false);
});

test("pruneVmCache is a no-op when the cache folder is missing", () => {
  resetCache();
  rmSync(cacheRoot, { recursive: true, force: true });
  assert.deepEqual(pruneVmCache(new Set()), []);
});
