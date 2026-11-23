#!/usr/bin/env node
/**
 * Check every pinned piece of a release for a newer upstream version, and optionally bump it.
 *
 * Used by the daily `bump.yml` workflow: `--list` prints the components with an update as JSON,
 * and `--apply <name>` re-checks one component and writes the version files. Plain Node 24 (global
 * fetch, no dependencies). Network errors for one component are reported and skipped, so the other
 * components still get checked.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GITHUB = "https://api.github.com";
const VERSIONS_FILE = "versions.json";
const CONTAINERFILE = "image/Containerfile";

/** Compare dotted numeric versions (`1.2.3`); a leading `v` and missing trailing parts are ignored. */
export function compareDotted(a, b) {
  const parse = (version) =>
    version
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** `version = "1.99.0 (abcdef 2026-01-01)"` inside `[pkg.rust]`, first word only. */
export function parseRustVersion(toml) {
  const lines = toml.split("\n");
  let inPackage = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inPackage = section[1].trim() === "pkg.rust";
      continue;
    }
    if (!inPackage) continue;
    const m = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1].trim().split(/\s+/)[0];
  }
  throw new Error("no [pkg.rust] version in the channel manifest");
}

/** passt tags look like `2026_10_02.cba3570`; newest first, one entry per tag. */
export function parsePasstTags(lsRemoteText) {
  const tags = new Set();
  for (const line of lsRemoteText.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const tag = fields[1].replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (/^\d{4}_\d{2}_\d{2}\.[0-9a-f]+$/.test(tag)) tags.add(tag);
  }
  return [...tags].sort((a, b) => passtTagKey(b).localeCompare(passtTagKey(a)));
}

/** The part of a passt tag that orders it: the date, then the commit hash. */
function passtTagKey(tag) {
  return tag.replace(/_/g, "-");
}

/** The value of `ARG <name>=<value>` in a Containerfile, or undefined. */
export function parseContainerfileArg(text, name) {
  for (const line of text.split("\n")) {
    const m = new RegExp(`^\\s*ARG\\s+${name}=(\\S+)\\s*$`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** Replace (or add) `ARG <name>=<value>` in a Containerfile. */
export function setContainerfileArg(text, name, value) {
  const line = `ARG ${name}=${value}`;
  const pattern = new RegExp(`^\\s*ARG\\s+${name}=\\S+\\s*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return text.replace(/\n*$/, "\n") + line + "\n";
}

/**
 * Apply one component's update to the release files. `files` maps a repo-relative path to its
 * contents; the returned map has the new contents. versions.json keeps its 2-space indent and
 * trailing newline.
 */
export function applyUpdate(name, files, found) {
  const result = { ...files };
  if (name === "pi") {
    result[CONTAINERFILE] = setContainerfileArg(files[CONTAINERFILE], "PI_VERSION", found.version);
    return result;
  }
  const versions = JSON.parse(files[VERSIONS_FILE]);
  switch (name) {
    case "libkrun":
      versions.libkrun = { ...versions.libkrun, version: found.version, tag: found.tag, commit: found.commit };
      break;
    case "libkrunfw":
      // The arm64 entries point at versioned URLs too, so they have to move with the parent or a
      // bump would leave a stale macOS/Linux arm64 pin behind.
      versions.libkrunfw = {
        ...versions.libkrunfw,
        version: found.version,
        url: found.url,
        sha256: found.sha256,
        source: found.source,
        macos: found.macos ?? versions.libkrunfw.macos,
        linux: found.linux ?? versions.libkrunfw.linux,
      };
      break;
    case "passt":
      versions.passt = { ...versions.passt, version: found.version, url: found.url, sha256: found.sha256 };
      break;
    case "rust":
      versions.rust = found.version;
      break;
    case "buildImage":
      versions.buildImage = found.image;
      break;
    case "node":
      versions.node = found.version;
      break;
    default:
      throw new Error(`unknown component "${name}"`);
  }
  result[VERSIONS_FILE] = JSON.stringify(versions, null, 2) + "\n";
  return result;
}

function githubHeaders(url) {
  const headers = { "User-Agent": "agent-hive" };
  if (process.env.GITHUB_TOKEN && new URL(url).hostname.endsWith("github.com")) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: githubHeaders(url) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: githubHeaders(url) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function sha256OfUrl(url) {
  const response = await fetch(url, { headers: githubHeaders(url) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const hash = createHash("sha256");
  hash.update(Buffer.from(await response.arrayBuffer()));
  return hash.digest("hex");
}

function lsRemote(repo, ref) {
  try {
    const out = execFileSync("git", ["ls-remote", repo, ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "") return undefined;
    return out.split("\n")[0].split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

async function checkLibkrun() {
  const rel = await fetchJson(`${GITHUB}/repos/containers/libkrun/releases/latest`);
  const tag = String(rel.tag_name ?? "").trim();
  if (!/^v?\d/.test(tag)) throw new Error(`unexpected release tag "${tag}"`);
  const version = tag.replace(/^v/, "");
  const commit =
    lsRemote("https://github.com/containers/libkrun", `refs/tags/${tag}^{}`) ??
    lsRemote("https://github.com/containers/libkrun", `refs/tags/${tag}`);
  if (commit === undefined) throw new Error(`could not resolve the commit for ${tag}`);
  return { version, tag, commit };
}

/**
 * One libkrunfw release asset, with the digest GitHub now publishes. When the API has no digest
 * (older releases), the caller downloads the asset and hashes it.
 */
function libkrunfwAsset(rel, tag, name) {
  const asset = (rel.assets ?? []).find((a) => a && a.name === name);
  const url =
    asset?.browser_download_url ??
    `https://github.com/containers/libkrunfw/releases/download/${tag}/${name}`;
  const digest = typeof asset?.digest === "string" ? asset.digest.replace(/^sha256:/, "") : "";
  return { url, digest: /^[0-9a-f]{64}$/.test(digest) ? digest : undefined };
}

async function checkLibkrunfw() {
  const rel = await fetchJson(`${GITHUB}/repos/containers/libkrunfw/releases/latest`);
  const tag = String(rel.tag_name ?? "").trim();
  if (!/^v?\d/.test(tag)) throw new Error(`unexpected release tag "${tag}"`);
  const version = tag.replace(/^v/, "");
  // The x86_64 asset still feeds the Linux release; the two arm64 assets are the macOS prebuilt
  // kernel bundle and the Linux arm64 library. All three move with the same version.
  const x86 = libkrunfwAsset(rel, tag, "libkrunfw-x86_64.tgz");
  const macos = libkrunfwAsset(rel, tag, "libkrunfw-prebuilt-aarch64.tgz");
  const linux = libkrunfwAsset(rel, tag, "libkrunfw-aarch64.tgz");
  return {
    version,
    url: x86.url,
    sha256: x86.digest ?? (await sha256OfUrl(x86.url)),
    source: `https://github.com/containers/libkrunfw/archive/refs/tags/v${version}.tar.gz`,
    macos: { aarch64: { url: macos.url, sha256: macos.digest ?? (await sha256OfUrl(macos.url)) } },
    linux: { aarch64: { url: linux.url, sha256: linux.digest ?? (await sha256OfUrl(linux.url)) } },
  };
}

async function checkPasst() {
  let out = "";
  try {
    out = execFileSync("git", ["ls-remote", "--tags", "https://passt.top/passt"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    throw new Error(`git ls-remote https://passt.top/passt failed: ${err.message}`);
  }
  const tags = parsePasstTags(out);
  if (tags.length === 0) throw new Error("no passt release tags found");
  const version = tags[0];
  const url = `https://passt.top/passt/snapshot/passt-${version}.tar.xz`;
  const sha256 = await sha256OfUrl(url);
  return { version, url, sha256 };
}

async function checkRust() {
  const toml = await fetchText("https://static.rust-lang.org/dist/channel-rust-stable.toml");
  return { version: parseRustVersion(toml) };
}

async function checkBuildImage() {
  const json = await fetchJson(
    "https://quay.io/api/v1/repository/pypa/manylinux_2_28_x86_64/tag/?specificTag=latest&onlyActiveTags=true",
  );
  const digest = json?.tags?.[0]?.manifest_digest;
  if (typeof digest !== "string" || digest === "") throw new Error("no manifest_digest for the latest tag");
  return { image: `quay.io/pypa/manylinux_2_28_x86_64@${digest}` };
}

async function checkNode() {
  const index = await fetchJson("https://nodejs.org/dist/index.json");
  if (!Array.isArray(index)) throw new Error("unexpected nodejs.org index");
  const current = JSON.parse(readFileSync(VERSIONS_FILE, "utf8")).node;
  const major = String(current ?? "").split(".")[0];
  if (!/^\d+$/.test(major)) throw new Error(`bad pinned Node version "${current}"`);
  const candidates = index
    .map((entry) => String(entry?.version ?? "").replace(/^v/, ""))
    .filter((version) => new RegExp(`^${major}\\.\\d+\\.\\d+$`).test(version));
  if (candidates.length === 0) throw new Error(`no Node ${major}.x release on nodejs.org`);
  candidates.sort(compareDotted);
  return { version: candidates[candidates.length - 1] };
}

async function checkPi() {
  const json = await fetchJson("https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest");
  const version = String(json.version ?? "");
  if (version === "") throw new Error("no version in the npm registry response");
  return { version };
}

function readFiles() {
  return {
    [VERSIONS_FILE]: readFileSync(VERSIONS_FILE, "utf8"),
    [CONTAINERFILE]: readFileSync(CONTAINERFILE, "utf8"),
  };
}

/** One entry per pinned component: how to read the current value, check upstream and compare. */
const COMPONENTS = [
  {
    name: "libkrun",
    current: (files) => JSON.parse(files[VERSIONS_FILE]).libkrun.version,
    check: checkLibkrun,
    latest: (found) => found.version,
    isUpdate: (cur, found) => compareDotted(found.version, cur) > 0,
  },
  {
    name: "libkrunfw",
    current: (files) => JSON.parse(files[VERSIONS_FILE]).libkrunfw.version,
    check: checkLibkrunfw,
    latest: (found) => found.version,
    isUpdate: (cur, found) => compareDotted(found.version, cur) > 0,
  },
  {
    name: "passt",
    current: (files) => JSON.parse(files[VERSIONS_FILE]).passt.version,
    check: checkPasst,
    latest: (found) => found.version,
    isUpdate: (cur, found) => passtTagKey(found.version).localeCompare(passtTagKey(cur)) > 0,
  },
  {
    name: "rust",
    current: (files) => JSON.parse(files[VERSIONS_FILE]).rust,
    check: checkRust,
    latest: (found) => found.version,
    isUpdate: (cur, found) => compareDotted(found.version, cur) > 0,
  },
  {
    name: "buildImage",
    current: (files) => JSON.parse(files[VERSIONS_FILE]).buildImage,
    check: checkBuildImage,
    latest: (found) => found.image,
    isUpdate: (cur, found) => found.image !== cur,
  },
  {
    name: "node",
    current: (files) => JSON.parse(files[VERSIONS_FILE]).node,
    check: checkNode,
    latest: (found) => found.version,
    isUpdate: (cur, found) => compareDotted(found.version, cur) > 0,
  },
  {
    name: "pi",
    current: (files) => parseContainerfileArg(files[CONTAINERFILE], "PI_VERSION"),
    check: checkPi,
    latest: (found) => found.version,
    isUpdate: (cur, found) => cur !== found.version && compareDotted(found.version, cur) > 0,
  },
];

/**
 * versions.json's `skip` lists upstream versions known to be broken for hive, by component:
 * `{ "libkrunfw": { "5.6.4": "reason" } }`. A skipped version is never offered.
 */
export function skipReason(files, name, version) {
  const skip = JSON.parse(files[VERSIONS_FILE]).skip ?? {};
  const reason = skip[name]?.[version];
  return typeof reason === "string" ? reason : undefined;
}

function usage() {
  return "usage: node scripts/check-updates.mjs [--list | --apply <component>]";
}

async function list(files) {
  const updates = [];
  for (const component of COMPONENTS) {
    try {
      const found = await component.check();
      const current = component.current(files);
      const skip = skipReason(files, component.name, component.latest(found));
      if (skip !== undefined) {
        process.stderr.write(`check-updates: ${component.name} ${component.latest(found)}: skipped (${skip})\n`);
        continue;
      }
      if (component.isUpdate(current, found)) {
        updates.push({ name: component.name, current: String(current), latest: component.latest(found) });
      }
    } catch (err) {
      process.stderr.write(`check-updates: ${component.name}: ${err.message}; skipping\n`);
    }
  }
  return updates;
}

async function apply(name, files) {
  const component = COMPONENTS.find((entry) => entry.name === name);
  if (component === undefined) throw new Error(`unknown component "${name}"`);
  const found = await component.check();
  const next = applyUpdate(name, files, found);
  for (const path of Object.keys(next)) {
    if (next[path] !== files[path]) writeFileSync(path, next[path]);
  }
  process.stderr.write(`check-updates: ${name} ${component.current(files)} → ${component.latest(found)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--list" || args.length === 0) {
    const updates = await list(readFiles());
    process.stdout.write(JSON.stringify(updates, null, 2) + "\n");
    return;
  }
  if (args[0] === "--apply" && args[1] !== undefined) {
    await apply(args[1], readFiles());
    return;
  }
  process.stderr.write(usage() + "\n");
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`check-updates: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
