#!/usr/bin/env node
/**
 * Decide whether the daily dev build reuses the previous VM rootfs or rebuilds it.
 *
 * The dev workflow keeps the previous release's `rootfs-info.json` (which image tree the rootfs
 * was built from and when) and the update counts it measured by booting that rootfs. Reuse is the
 * normal case: a 660 MB rootfs rebuild and download is only worth it when the image changed, when
 * there are pending security updates, or when the rootfs is old enough that the batching rule says
 * to take its updates now.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";


export const REBUILD_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function decide({ info, imageTree, now, securityUpdates, anyUpdates, force = false }) {
  if (force) return { action: "rebuild", reason: "forced" };
  if (!info) return { action: "rebuild", reason: "no previous rootfs" };
  if (info.imageTree !== imageTree) return { action: "rebuild", reason: "image/ changed" };
  if (securityUpdates > 0) {
    return { action: "rebuild", reason: `${securityUpdates} security updates` };
  }
  const nowMs = typeof now === "number" ? now : now.getTime();
  const builtMs = Date.parse(info.built);
  const ageMs = nowMs - builtMs;
  if (anyUpdates > 0 && ageMs >= REBUILD_AFTER_DAYS * DAY_MS) {
    const days = Math.floor(ageMs / DAY_MS);
    return { action: "rebuild", reason: `${anyUpdates} updates, rootfs is ${days} days old` };
  }
  return { action: "reuse", reason: `rootfs ${info.rootfs} is current` };
}

function usage() {
  return "usage: node scripts/rootfs-plan.mjs --info <file|-> --image-tree <hash> [--security N] [--updates N] [--force]";
}

async function main() {
  const { values } = parseArgs({
    options: {
      info: { type: "string" },
      "image-tree": { type: "string" },
      security: { type: "string" },
      updates: { type: "string" },
      force: { type: "boolean" },
    },
  });
  if (values.info === undefined || values["image-tree"] === undefined) {
    process.stderr.write(usage() + "\n");
    process.exitCode = 2;
    return;
  }
  let text;
  if (values.info === "-") {
    text = readFileSync(0, "utf8");
  } else {
    text = readFileSync(values.info, "utf8");
  }
  const info = text.trim() === "" ? null : JSON.parse(text);
  const decision = decide({
    info,
    imageTree: values["image-tree"],
    now: Date.now(),
    securityUpdates: Number(values.security ?? "0"),
    anyUpdates: Number(values.updates ?? "0"),
    force: values.force === true,
  });
  process.stdout.write(JSON.stringify(decision) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`rootfs-plan: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
