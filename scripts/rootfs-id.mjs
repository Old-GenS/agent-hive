#!/usr/bin/env node
/**
 * The id a VM filesystem is published under.
 *
 * A release names its VM image by this id (`ROOTFS_VERSION` in the bundle, and the id in
 * `hive-rootfs-<id>-linux-x86_64.tar.gz`), and an installed hive downloads the image only when the
 * id it already has is different. So the id must change when the image changes and must *not*
 * change when it did not.
 *
 * A podman image id cannot be that: `build:image:fresh` runs with `--no-cache`, so two builds of an
 * unchanged image get different ids and every release would make every install re-download the
 * whole ~660 MB. Instead the id is the one thing that decides what a task sees: the `image/` tree
 * this checkout built from, and the exact set of installed RPMs.
 *
 * The bytes of two such builds still differ (timestamps, the rpm database), so a rebuild does not
 * produce a byte-identical archive. What the id promises is the same packages and the same
 * `image/` sources, which is what the VM runs.
 *
 * CLI: reads `rpm -qa` on stdin, prints the id.
 *
 *   podman run --rm "$IMAGE" rpm -qa | node scripts/rootfs-id.mjs --image-tree "$(git rev-parse HEAD:image)"
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The 12-character id for an image built from `imageTree` with these packages installed. Package
 * order does not matter: `rpm -qa` order is not stable between builds.
 */
export function rootfsId({ imageTree, packages }) {
  const sorted = [...packages]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  const hash = createHash("sha256");
  hash.update("agent-hive-rootfs-v1\n");
  hash.update(String(imageTree ?? ""));
  hash.update("\n");
  for (const line of sorted) {
    hash.update(line);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 12);
}

function main() {
  const args = process.argv.slice(2);
  let imageTree;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--image-tree") {
      imageTree = args[i + 1];
      i++;
    } else if (args[i].startsWith("--image-tree=")) {
      imageTree = args[i].slice("--image-tree=".length);
    } else {
      process.stderr.write("usage: node scripts/rootfs-id.mjs --image-tree <hash> [< rpm -qa output]\n");
      process.exit(2);
    }
  }
  if (!imageTree) {
    process.stderr.write("rootfs-id: --image-tree is required (git rev-parse HEAD:image)\n");
    process.exit(2);
  }
  const packages = readFileSync(0, "utf8").split("\n");
  process.stdout.write(`${rootfsId({ imageTree, packages })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
