#!/usr/bin/env node
/**
 * Checks the release build and the promotion command share, so a release can only ship a rootfs
 * that provably belongs to it.
 *
 * A rootfs asset answers two questions: which `image/` tree it was built from (`rootfs-info.json`'s
 * `imageTree`) and which rootfs id it is (`rootfs-info.json`'s `rootfs`, which must match the
 * `hive-rootfs-<id>-linux-x86_64.tar.gz` file name). `scripts/build-release.sh` runs the check, so
 * a release cannot be paired with a rootfs from another image tree (an old pi, older distro
 * packages, or a different `image/`). It also holds the release numbering: the next stable
 * version, computed from the release list.
 *
 * CLI, used by build-release.sh: prints the rootfs id, or exits 1 with the reason:
 *
 *   node scripts/release-rootfs.mjs --reuse <tarball> --info <rootfs-info.json> --image-tree <hash>
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const ROOTFS_NAME = /^hive-rootfs-([0-9a-f]{12})-linux-x86_64\.tar\.gz$/;

/** The rootfs id in a release asset name. */
export function parseRootfsName(name) {
  const m = ROOTFS_NAME.exec(name);
  if (!m) {
    throw new Error(
      `rootfs file name must be hive-rootfs-<12 hex>-linux-x86_64.tar.gz (got "${name}")`,
    );
  }
  return m[1];
}

/**
 * Validate a rootfs tarball name plus its rootfs-info.json against the image tree the release is
 * built from. Returns the rootfs id; throws a message a release build can print as-is.
 */
export function validateRootfs({ name, info, imageTree }) {
  const rver = parseRootfsName(name);
  if (info === null || typeof info !== "object") {
    throw new Error("rootfs-info.json is missing or not a JSON object");
  }
  if (info.rootfs !== rver) {
    throw new Error(
      `rootfs-info.json names rootfs "${info.rootfs}", but the file is hive-rootfs-${rver}-...`,
    );
  }
  if (typeof info.imageTree !== "string" || info.imageTree.length === 0) {
    throw new Error("rootfs-info.json has no imageTree");
  }
  if (imageTree === undefined || imageTree.length === 0) {
    throw new Error("the release is not in a git checkout, so its image/ tree is unknown");
  }
  if (info.imageTree !== imageTree) {
    throw new Error(
      `the rootfs was built from image/ tree ${info.imageTree}, but this release's tree is ` +
        `${imageTree}; build the rootfs from this tree, which npm run release does when no ` +
        `rootfs is handed to it`,
    );
  }
  return rver;
}

/** A release tag's version and whether it is a prerelease, or undefined for anything else. */
function parseReleaseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(?:nightly|dev|beta)\.(\d+))?$/.exec(tag);
  if (m === null) return undefined;
  return {
    version: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] !== undefined,
  };
}

/** Compare two `x.y.z` versions numerically: -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (pa === undefined || pb === undefined) throw new Error(`cannot compare "${a}" with "${b}"`);
  for (let i = 0; i < 3; i += 1) {
    if (pa.version[i] !== pb.version[i]) return pa.version[i] < pb.version[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The newest release among `tags`: `{ tag, version, prerelease }`, or undefined when there is no
 * release tag. `0.5.9-nightly.12` is newer than `0.5.8`, and `0.5.9` is newer than
 * `0.5.9-nightly.12`.
 */
export function newestRelease(tags) {
  let best;
  for (const tag of tags) {
    const parsed = parseReleaseTag(tag);
    if (parsed === undefined) continue;
    const entry = { tag, ...parsed };
    if (best === undefined || compareVersions(parsed.version.join("."), best.version.join(".")) > 0) {
      best = entry;
    } else if (
      compareVersions(parsed.version.join("."), best.version.join(".")) === 0 &&
      best.prerelease &&
      !parsed.prerelease
    ) {
      best = entry;
    }
  }
  return best;
}

/**
 * The version a stable release from main gets: the patch after the newest release, or the version
 * the nightlies are already previewing. Nothing reads package.json in the normal case
 * (`fallbackVersion` is for a repository that has never published a release).
 */
export function nextStableVersion(tags, fallbackVersion) {
  const newest = newestRelease(tags);
  if (newest === undefined) {
    if (fallbackVersion === undefined || !/^\d+\.\d+\.\d+$/.test(fallbackVersion)) {
      throw new Error("no release tag and no package.json version to number a release after");
    }
    return fallbackVersion;
  }
  if (newest.prerelease) return newest.version.join(".");
  return `${newest.version[0]}.${newest.version[1]}.${newest.version[2] + 1}`;
}

/** The SHA-256 of `name` in a SHA256SUMS file (the plain `hash  name` format), or undefined. */
export function sumsEntry(sums, name) {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m !== null && m[2] === name) return m[1];
  }
  return undefined;
}

function usage() {
  return (
    "usage: node scripts/release-rootfs.mjs --reuse <tarball> --info <rootfs-info.json> " +
    "--image-tree <hash>"
  );
}

function main() {
  const { values } = parseArgs({
    options: {
      reuse: { type: "string" },
      info: { type: "string" },
      "image-tree": { type: "string" },
    },
  });
  if (values.reuse === undefined || values.info === undefined || values["image-tree"] === undefined) {
    process.stderr.write(usage() + "\n");
    process.exitCode = 2;
    return;
  }
  try {
    const tarball = values.reuse.split("/").pop();
    const info = JSON.parse(readFileSync(values.info, "utf8"));
    const rver = validateRootfs({ name: tarball, info, imageTree: values["image-tree"] });
    process.stdout.write(rver + "\n");
  } catch (err) {
    process.stderr.write(
      `release-rootfs: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
