#!/usr/bin/env node
/**
 * Naming and sizing for the macOS VM image (docs/MACOS.md, Phase 2).
 *
 * A macOS guest boots a raw ext4 image over virtio-blk instead of a folder rootfs: APFS is
 * case-insensitive and an exported folder loses root ownership, setuid bits and device nodes.
 * scripts/build-rootfs-image.sh builds one; these helpers are pure so the shell script and the
 * tests agree on the asset name and the size arithmetic.
 *
 * CLI:
 *   node scripts/rootfs-image.mjs name <rootfs-id> [platform]  # hive-rootfs-<id>-<platform>.img.gz
 *   node scripts/rootfs-image.mjs size <content-bytes>         # bytes for the sparse image
 */
import { pathToFileURL } from "node:url";

export const IMAGE_PLATFORMS = ["linux-arm64", "linux-x86_64"];

/** The image never goes below this, even for a tiny rootfs: ext4 metadata needs room. */
export const MIN_IMAGE_BYTES = 1024 ** 3;

const MIB = 1024 ** 2;

/**
 * The release asset name. The rootfs id comes from scripts/rootfs-id.mjs — the `image/` tree plus
 * the installed RPMs — the same id the Linux folder rootfs tarball uses, so one build's pieces are
 * recognisable as a set.
 */
export function rootfsImageName(rootfsId, platform = "linux-arm64") {
  if (!/^[0-9a-f]{12}$/.test(rootfsId)) {
    throw new Error('rootfs id must be 12 lowercase hex digits (got "' + rootfsId + '")');
  }
  if (!IMAGE_PLATFORMS.includes(platform)) {
    throw new Error("image platform must be one of " + IMAGE_PLATFORMS.join(", ") + ' (got "' + platform + '")');
  }
  return "hive-rootfs-" + rootfsId + "-" + platform + ".img.gz";
}

/**
 * Bytes for the raw image holding contentBytes of files. ext4 needs room for its inode tables,
 * block bitmaps and journal; 15% plus 512 MiB is comfortably above that for a Fedora-sized tree.
 * The unused blocks stay sparse zeros, so the headroom costs almost nothing in the gzipped asset.
 */
export function imageSizeBytes(contentBytes) {
  if (!Number.isSafeInteger(contentBytes) || contentBytes <= 0) {
    throw new Error('content size must be a positive integer (got "' + contentBytes + '")');
  }
  const wanted = Math.ceil(contentBytes * 1.15 + 512 * MIB);
  const rounded = Math.ceil(wanted / (64 * MIB)) * 64 * MIB;
  return Math.max(MIN_IMAGE_BYTES, rounded);
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const [command, value, platform] = process.argv.slice(2);
  try {
    if (command === "name" && value !== undefined) {
      console.log(rootfsImageName(value, platform));
    } else if (command === "size" && value !== undefined) {
      console.log(String(imageSizeBytes(Number(value))));
    } else {
      console.error("usage: rootfs-image.mjs name <rootfs-id> [platform] | size <content-bytes>");
      process.exitCode = 2;
    }
  } catch (err) {
    console.error("rootfs-image: " + (err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}
