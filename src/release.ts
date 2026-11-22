/**
 * Release installation and updates for the bundled `hive`.
 *
 * Layout under the data dir:
 *   versions/<version>/   an extracted app bundle (bin/hive, lib/, libexec/, VERSION, ROOTFS_VERSION)
 *   current               symlink to the active version
 *   previous              symlink to the version `hive update --rollback` goes back to
 *   rootfs/<rootfs-version>/ the extracted VM root filesystem, with a `.complete` marker
 *
 * Every path is computed at call time from the environment (XDG dirs, HOME), never at import
 * time, so tests and callers can point the data dir wherever they like.
 */
import { createHash, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PRERELEASE_PUBLIC_KEY, RELEASE_PUBLIC_KEY } from "./release-key.js";

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function dataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
}

function cacheHome(): string {
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

export function dataDir(): string {
  return join(dataHome(), "agent-hive");
}

export function versionsDir(): string {
  return join(dataDir(), "versions");
}

export function currentLink(): string {
  return join(dataDir(), "current");
}

export function previousLink(): string {
  return join(dataDir(), "previous");
}

export function rootfsDir(): string {
  return join(dataDir(), "rootfs");
}

export function binLink(): string {
  return join(homedir(), ".local/bin/hive");
}

export function cacheFile(): string {
  return join(cacheHome(), "agent-hive/update-check.json");
}

/**
 * Compare dotted numeric versions. A leading `v` and missing trailing parts are ignored, and an
 * optional `-nightly.N` prerelease (the old `-dev.N` / `-beta.N` spellings are aliases) sorts
 * below the same `X.Y.Z` without one; prereleases of the same version compare by N, whichever
 * word they use.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (version: string): { parts: number[]; prerelease: number | undefined } => {
    const m = /^(\d+(?:\.\d+)*)(?:-(?:nightly|dev|beta)\.(\d+))?$/.exec(version.replace(/^v/, ""));
    if (!m) throw new Error(`bad version: ${version}`);
    return {
      parts: m[1].split(".").map((part) => Number.parseInt(part, 10)),
      prerelease: m[2] === undefined ? undefined : Number.parseInt(m[2], 10),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  const length = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < length; i++) {
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === undefined) return 1;
  if (pb.prerelease === undefined) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/**
 * True when `version` is a prerelease (`X.Y.Z-nightly.N`), or uses one of the old prerelease
 * aliases (`X.Y.Z-dev.N`, `X.Y.Z-beta.N`), with or without a leading `v`.
 */
export function isPrerelease(version: string): boolean {
  return /^v?\d+(?:\.\d+)*-(?:nightly|dev|beta)\.\d+$/.test(version);
}

export type Channel = "stable" | "nightly";

/** Where the update channel is remembered: a file in the data dir. */
export function channelFile(): string {
  return join(dataDir(), "channel");
}

/** The channel this install follows; the old `dev` and `beta` file values are aliases for nightly. */
export function readChannel(): Channel {
  try {
    const saved = readFileSync(channelFile(), "utf8").trim();
    return saved === "nightly" || saved === "dev" || saved === "beta" ? "nightly" : "stable";
  } catch {
    return "stable";
  }
}

export function writeChannel(channel: Channel): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(channelFile(), channel + "\n");
}

/** The release keys this channel trusts. Empty strings are dropped. */
export function trustedKeys(channel: Channel): string[] {
  return (channel === "nightly" ? [RELEASE_PUBLIC_KEY, PRERELEASE_PUBLIC_KEY] : [RELEASE_PUBLIC_KEY]).filter(
    (key) => key !== "",
  );
}

/** The directory that holds the running bundle, when this copy was installed from a release. */
export function bundleRoot(): string | undefined {
  return process.env.HIVE_BUNDLE_ROOT || undefined;
}

/**
 * Where the web UI's built files (`ui/dist`) can be, in the order to try: an explicit
 * HIVE_UI_DIR, the installed release bundle's `ui/dist`, then a source checkout's `ui/dist`
 * relative to the running module (`<checkout>/dist` -> `<checkout>/ui/dist`).
 */
export function uiDistCandidates(env: NodeJS.ProcessEnv, here: string): string[] {
  const candidates: string[] = [];
  if (env.HIVE_UI_DIR) candidates.push(env.HIVE_UI_DIR);
  if (env.HIVE_BUNDLE_ROOT) candidates.push(join(env.HIVE_BUNDLE_ROOT, "ui", "dist"));
  candidates.push(join(here, "..", "ui", "dist"));
  return candidates;
}

/** The released version this bundle came from, or undefined when running from source. */
export function currentVersion(): string | undefined {
  const root = bundleRoot();
  if (!root) return undefined;
  return readFileSync(join(root, "VERSION"), "utf8").trim();
}

/** Parse a SHA256SUMS file: `<64 hex>  <name>` lines, optionally with a `*` before the name. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(raw);
    if (!m) continue;
    sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** True when `sigBase64` is a valid signature over `sums` made with the release key. */
export function verifySums(sums: Buffer, sigBase64: string, publicKeyPem: string): boolean {
  try {
    return verify(null, sums, publicKeyPem, Buffer.from(sigBase64.trim(), "base64"));
  } catch {
    return false;
  }
}

/** True when any of `publicKeys` verifies the signature over `sums`. */
export function verifySumsAny(sums: Buffer, sigBase64: string, publicKeys: string[]): boolean {
  return publicKeys.some((publicKey) => verifySums(sums, sigBase64, publicKey));
}

/** SHA-256 of a file, read in a stream so release tarballs never sit in memory. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export type ReleaseAsset = { name: string; url: string; downloadUrl: string };
export type Release = { version: string; assets: ReleaseAsset[] };

function releaseToken(): string | undefined {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
}

function releaseApi(): string {
  return process.env.HIVE_RELEASE_API || "https://api.github.com";
}

function releaseRepo(): string {
  return process.env.HIVE_RELEASE_REPO || "ogsapps/agent-hive";
}

type RawRelease = {
  tag_name?: string;
  draft?: boolean;
  assets?: { name?: string; url?: string; browser_download_url?: string }[];
};

function toRelease(json: RawRelease): Release {
  return {
    version: String(json.tag_name ?? "").replace(/^v/, ""),
    assets: (json.assets ?? []).map((asset) => ({
      name: String(asset.name ?? ""),
      url: String(asset.url ?? ""),
      downloadUrl: String(asset.browser_download_url ?? ""),
    })),
  };
}

async function fetchReleaseJson(url: string, timeoutMs: number): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-hive",
  };
  const token = releaseToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`release lookup failed: HTTP ${response.status}`);
  return response.json();
}

/**
 * Look up the latest release, or a specific tag, on GitHub (or HIVE_RELEASE_API). Without a tag,
 * the stable channel uses `/releases/latest`; the nightly channel lists the recent releases and picks
 * the highest version, prereleases included.
 */
export async function fetchRelease(tag?: string, timeoutMs = 30_000, channel: Channel = "stable"): Promise<Release> {
  if (tag !== undefined) {
    const json = (await fetchReleaseJson(
      `${releaseApi()}/repos/${releaseRepo()}/releases/tags/${tag}`,
      timeoutMs,
    )) as RawRelease;
    return toRelease(json);
  }
  if (channel === "stable") {
    const json = (await fetchReleaseJson(
      `${releaseApi()}/repos/${releaseRepo()}/releases/latest`,
      timeoutMs,
    )) as RawRelease;
    return toRelease(json);
  }

  const json = await fetchReleaseJson(
    `${releaseApi()}/repos/${releaseRepo()}/releases?per_page=30`,
    timeoutMs,
  );
  if (!Array.isArray(json)) throw new Error("no releases found");
  let best: Release | undefined;
  for (const item of json as RawRelease[]) {
    if (item === null || typeof item !== "object" || item.draft) continue;
    const release = toRelease(item);
    try {
      compareVersions(release.version, release.version);
    } catch {
      continue;
    }
    if (best === undefined || compareVersions(release.version, best.version) > 0) best = release;
  }
  if (best === undefined) throw new Error("no releases found");
  return best;
}

/** How far a download has got: bytes received and the total when the server sent one. */
export interface DownloadProgress {
  received: number;
  total: number | undefined;
}

export type OnProgress = (progress: DownloadProgress) => void;

/** Download one release asset to `dest`, optionally reporting progress (from Content-Length). */
export async function download(
  asset: ReleaseAsset,
  dest: string,
  timeoutMs = 600_000,
  onProgress?: OnProgress,
): Promise<void> {
  const token = releaseToken();
  const headers: Record<string, string> = { "User-Agent": "agent-hive" };
  if (token) {
    headers.Accept = "application/octet-stream";
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(token ? asset.url : asset.downloadUrl, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${asset.name}: HTTP ${response.status}`);
  }
  const length = response.headers.get("content-length");
  const total = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
  let received = 0;
  if (onProgress) onProgress({ received, total });
  async function* counted(source: AsyncIterable<Buffer | string>): AsyncIterable<Buffer | string> {
    for await (const chunk of source) {
      received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (onProgress) onProgress({ received, total });
      yield chunk;
    }
  }
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    (source) => counted(source as AsyncIterable<Buffer | string>),
    createWriteStream(dest),
  );
}

/** Download, verify and unpack the rootfs a release points at. */
export async function ensureRootfs(
  rel: Release,
  rver: string,
  sums: Map<string, string>,
  tmp: string,
  onProgress?: OnProgress,
): Promise<void> {
  const dest = join(rootfsDir(), rver);
  if (existsSync(join(dest, ".complete"))) return;

  const name = `hive-rootfs-${rver}-linux-x86_64.tar.gz`;
  const asset = rel.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`release has no rootfs ${rver}`);
  const file = join(tmp, name);
  await download(asset, file, 600_000, onProgress);
  const actual = await sha256File(file);
  if (actual !== sums.get(name)) throw new Error(`checksum mismatch: ${name}`);

  const dir = join(rootfsDir(), `.tmp-${rver}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-xzf", file, "-C", dir, "--no-same-owner"]);
  if (!existsSync(join(dir, "usr/local/bin/hive-vm-init"))) throw new Error("bad rootfs archive");
  writeFileSync(join(dir, ".complete"), "");
  renameSync(dir, dest);
}

/**
 * Install a release into `versions/<version>` and fetch its rootfs unless it is already there.
 * Nothing is activated: call activate() once this returns.
 */
export async function installRelease(rel: Release, o: { publicKeys?: string[] } = {}): Promise<string> {
  const keys = (o.publicKeys ?? trustedKeys(readChannel())).filter((key) => key !== "");
  if (keys.length === 0) throw new Error("this build has no release signing key, so updates can't be verified");

  const app = `hive-${rel.version}-linux-x86_64.tar.gz`;
  const sumsAsset = rel.assets.find((a) => a.name === "SHA256SUMS");
  const sigAsset = rel.assets.find((a) => a.name === "SHA256SUMS.sig");
  const appAsset = rel.assets.find((a) => a.name === app);
  if (!sumsAsset || !sigAsset || !appAsset) {
    throw new Error(`release v${rel.version} has no linux-x86_64 build`);
  }

  mkdirSync(dataDir(), { recursive: true });
  const tmp = mkdtempSync(join(dataDir(), ".tmp-"));
  try {
    const sumsPath = join(tmp, "SHA256SUMS");
    const sigPath = join(tmp, "SHA256SUMS.sig");
    await download(sumsAsset, sumsPath);
    await download(sigAsset, sigPath);
    const sums = readFileSync(sumsPath);
    const sig = readFileSync(sigPath, "utf8");
    if (!verifySumsAny(sums, sig, keys)) throw new Error("release signature check failed");

    const appPath = join(tmp, app);
    await download(appAsset, appPath);
    const actual = await sha256File(appPath);
    const expected = parseSums(sums.toString("utf8")).get(app);
    if (actual !== expected) throw new Error(`checksum mismatch: ${app}`);

    const dest = join(versionsDir(), rel.version);
    if (!existsSync(join(dest, "VERSION"))) {
      const x = join(tmp, "x");
      mkdirSync(x, { recursive: true });
      execFileSync("tar", ["-xzf", appPath, "-C", x]);
      const extracted = join(x, `hive-${rel.version}`);
      if (!existsSync(join(extracted, "VERSION"))) throw new Error("bad app bundle");
      mkdirSync(versionsDir(), { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      renameSync(extracted, dest);
    }

    const rver = readFileSync(join(dest, "ROOTFS_VERSION"), "utf8").trim();
    if (rver !== "none") {
      await ensureRootfs(rel, rver, parseSums(sums.toString("utf8")), tmp);
    }
    return dest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Download the VM rootfs that belongs to the running bundle (hive setup). `onProgress` is called
 * as the archive downloads; it is never required.
 */
export async function setupRootfs(
  o: { publicKeys?: string[]; onProgress?: OnProgress } = {},
): Promise<string> {
  if (!bundleRoot()) throw new Error("not an installed release");
  const rver = readFileSync(join(bundleRoot() as string, "ROOTFS_VERSION"), "utf8").trim();
  const dest = join(rootfsDir(), rver);
  if (existsSync(join(dest, ".complete"))) return dest;

  // A prerelease build trusts the prerelease key too, whether or not the channel file says so.
  const channel: Channel =
    isPrerelease(currentVersion() ?? "0.0.0") || readChannel() === "nightly" ? "nightly" : "stable";
  const keys = (o.publicKeys ?? trustedKeys(channel)).filter((key) => key !== "");
  if (keys.length === 0) throw new Error("this build has no release signing key, so updates can't be verified");

  const rel = await fetchRelease(`v${currentVersion()}`);
  const sumsAsset = rel.assets.find((a) => a.name === "SHA256SUMS");
  const sigAsset = rel.assets.find((a) => a.name === "SHA256SUMS.sig");
  if (!sumsAsset || !sigAsset) throw new Error(`release v${rel.version} has no linux-x86_64 build`);

  mkdirSync(dataDir(), { recursive: true });
  const tmp = mkdtempSync(join(dataDir(), ".tmp-"));
  try {
    const sumsPath = join(tmp, "SHA256SUMS");
    const sigPath = join(tmp, "SHA256SUMS.sig");
    await download(sumsAsset, sumsPath);
    await download(sigAsset, sigPath);
    const sums = readFileSync(sumsPath);
    if (!verifySumsAny(sums, readFileSync(sigPath, "utf8"), keys)) {
      throw new Error("release signature check failed");
    }
    await ensureRootfs(rel, rver, parseSums(sums.toString("utf8")), tmp, o.onProgress);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}

/** Point a symlink at `target` by renaming a fresh temp symlink over it. */
function switchLink(link: string, target: string): void {
  const tmp = `${link}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

/** Make `version` the current version, keeping the old one as `previous`. */
export function activate(version: string): void {
  const target = join(versionsDir(), version);
  mkdirSync(dataDir(), { recursive: true });
  let old: string | undefined;
  try {
    old = readlinkSync(currentLink());
  } catch {
    old = undefined;
  }
  switchLink(currentLink(), target);
  if (old !== undefined && old !== target) switchLink(previousLink(), old);

  mkdirSync(dirname(binLink()), { recursive: true });
  let isSymlink = false;
  try {
    isSymlink = lstatSync(binLink()).isSymbolicLink();
  } catch {
    isSymlink = false;
  }
  if (!existsSync(binLink()) || isSymlink) {
    switchLink(binLink(), join(currentLink(), "bin/hive"));
  } else {
    console.error(`hive: ${binLink()} exists and isn't a symlink; not changing it`);
  }
}

/** Swap current and previous, returning the version that is now current. */
export function rollback(): string {
  let previous: string;
  try {
    previous = readlinkSync(previousLink());
  } catch {
    throw new Error("no previous version to roll back to");
  }
  let current: string | undefined;
  try {
    current = readlinkSync(currentLink());
  } catch {
    current = undefined;
  }
  if (current !== undefined) switchLink(previousLink(), current);
  switchLink(currentLink(), previous);
  return basename(previous);
}

/** Remove versions and rootfs dirs that neither the current nor the previous version uses. */
export function prune(): void {
  const keep = new Set<string>();
  for (const link of [currentLink(), previousLink()]) {
    try {
      keep.add(basename(readlinkSync(link)));
    } catch {
      // A missing link just means there is nothing to keep for it.
    }
  }

  if (existsSync(versionsDir())) {
    for (const entry of readdirSync(versionsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || keep.has(entry.name)) continue;
      rmSync(join(versionsDir(), entry.name), { recursive: true, force: true });
    }
  }

  // The current and previous versions name the rootfs dirs they need.
  const keepRootfs = new Set<string>();
  for (const version of keep) {
    try {
      const rver = readFileSync(join(versionsDir(), version, "ROOTFS_VERSION"), "utf8").trim();
      if (rver) keepRootfs.add(rver);
    } catch {
      // No ROOTFS_VERSION means nothing to keep for this version.
    }
  }
  if (existsSync(rootfsDir())) {
    for (const entry of readdirSync(rootfsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!/^[0-9a-f]{12}$/.test(entry.name)) continue;
      if (keepRootfs.has(entry.name)) continue;
      rmSync(join(rootfsDir(), entry.name), { recursive: true, force: true });
    }
  }
}

/** Once a day, when installed from a release, say that a newer version exists. */
export async function updateNotice(): Promise<string | undefined> {
  if (!bundleRoot() || process.env.HIVE_NO_UPDATE_CHECK === "1") return undefined;
  try {
    const current = currentVersion();
    if (!current) return undefined;

    let latest: string | undefined;
    try {
      const cached = JSON.parse(readFileSync(cacheFile(), "utf8")) as {
        checkedAt?: number;
        latest?: string;
      };
      if (
        typeof cached.checkedAt === "number" &&
        typeof cached.latest === "string" &&
        Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS
      ) {
        latest = cached.latest;
      }
    } catch {
      latest = undefined;
    }
    if (latest === undefined) {
      const rel = await fetchRelease(undefined, 3000, readChannel());
      latest = rel.version;
      mkdirSync(dirname(cacheFile()), { recursive: true });
      writeFileSync(cacheFile(), JSON.stringify({ checkedAt: Date.now(), latest }));
    }
    if (compareVersions(latest, current) > 0) {
      return `hive: version ${latest} is available (you have ${current}); run hive update`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
