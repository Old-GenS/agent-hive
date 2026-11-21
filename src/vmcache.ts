/**
 * Per-repo VM cache buckets. The agent's `~/.cache` (npm, pip, Playwright, corepack) is kept between
 * runs, but each repo gets its own bucket under `<HIVE_VM_CACHE>/repos/<cacheKey>`: runs of the same
 * repo share one, runs of different repos never see each other's. A host-only `<key>.used` marker
 * next to each bucket records when the bucket was last handed to a run, so old buckets can be
 * pruned; it sits outside the bucket so no VM can touch it.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { githubSlug } from "./git.js";
import type { RunMeta } from "./runs.js";

/** The run fields the cache identity is built from. */
type CacheMeta = Pick<RunMeta, "source" | "repo" | "newRepo">;

/**
 * A stable identity for the repo behind a run, hashed to 16 hex characters. A github repo in any
 * form (`https://`, `ssh://`, `git@`) and any case gives the same key; a local path is resolved
 * through symlinks; a new project is its name.
 */
export function cacheKey(meta: CacheMeta): string {
  let identity: string;
  if (meta.source === "new") {
    identity = "new:" + meta.newRepo!.name.toLowerCase();
  } else if (meta.source === "local") {
    let repo = meta.repo;
    try {
      repo = realpathSync(meta.repo);
    } catch {
      // A checkout that is gone (or unreadable) still gets a stable-enough key.
    }
    identity = "local:" + repo;
  } else {
    const slug = githubSlug(meta.repo);
    identity = slug !== undefined ? "github:" + slug.toLowerCase() : meta.repo.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  }
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** The repo's cache bucket, or undefined when the VM cache is disabled. May not exist yet. */
export function cacheBucket(meta: CacheMeta): string | undefined {
  if (!config.sandbox.vmCache) return undefined;
  return join(config.sandbox.vmCache, "repos", cacheKey(meta));
}

/** Like `cacheBucket`, but create the bucket and stamp its `.used` marker before a run uses it. */
export function useCacheBucket(meta: CacheMeta): string | undefined {
  const bucket = cacheBucket(meta);
  if (!bucket) return undefined;
  mkdirSync(bucket, { recursive: true });
  const now = new Date();
  const marker = join(config.sandbox.vmCache, "repos", cacheKey(meta) + ".used");
  writeFileSync(marker, "");
  utimesSync(marker, now, now);
  return bucket;
}

/**
 * Delete old cache data: every legacy entry directly under the cache root (the old flat cache),
 * and, when `config.vmCacheDays > 0`, every repos/ bucket not in `liveKeys` whose `.used` marker is
 * missing or older than that many days. A `.used` marker whose bucket is gone is removed too. A
 * symlink in repos/ is deleted without following it. Returns the deleted bucket keys.
 */
export function pruneVmCache(liveKeys: Set<string>, now = Date.now()): string[] {
  const root = config.sandbox.vmCache;
  if (!root || !existsSync(root)) return [];
  const deleted: string[] = [];

  // The old flat cache: one shared ~/.cache. Remove everything except the per-repo buckets.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "repos") continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
  }

  const repos = join(root, "repos");
  let entries;
  try {
    entries = readdirSync(repos, { withFileTypes: true });
  } catch {
    return deleted;
  }
  if (config.vmCacheDays <= 0) return deleted;
  const cutoff = now - config.vmCacheDays * 86_400_000;

  for (const entry of entries) {
    if (entry.name.endsWith(".used")) continue;
    const key = entry.name;
    const bucket = join(repos, key);
    let stat;
    try {
      stat = lstatSync(bucket);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      // Never recurse through it: remove the link itself.
      rmSync(bucket, { force: true });
      deleted.push(key);
      continue;
    }
    if (!stat.isDirectory() || liveKeys.has(key)) continue;

    const marker = join(repos, key + ".used");
    let usedAt: number | undefined;
    try {
      usedAt = lstatSync(marker).mtimeMs;
    } catch {
      usedAt = undefined;
    }
    if (usedAt !== undefined && usedAt >= cutoff) continue;
    rmSync(bucket, { recursive: true, force: true });
    rmSync(marker, { force: true });
    deleted.push(key);
  }

  // Markers whose bucket is already gone.
  for (const entry of entries) {
    if (!entry.name.endsWith(".used")) continue;
    const key = entry.name.slice(0, -".used".length);
    if (!existsSync(join(repos, key))) rmSync(join(repos, entry.name), { force: true });
  }
  return deleted;
}
