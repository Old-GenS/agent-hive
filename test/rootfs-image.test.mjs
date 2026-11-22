// The macOS VM image's asset name and size arithmetic (docs/MACOS.md, Phase 2). Pure functions:
// no podman and no Linux needed.
import test from "node:test";
import assert from "node:assert/strict";
import { imageSizeBytes, rootfsImageName, IMAGE_PLATFORMS, MIN_IMAGE_BYTES } from "../scripts/rootfs-image.mjs";

const MIB = 1024 ** 2;

test("rootfsImageName uses the release asset naming", () => {
  assert.equal(rootfsImageName("0123456789ab"), "hive-rootfs-0123456789ab-linux-arm64.img.gz");
  assert.equal(
    rootfsImageName("0123456789ab", "linux-x86_64"),
    "hive-rootfs-0123456789ab-linux-x86_64.img.gz",
  );
});

test("rootfsImageName rejects an id or platform a release could not parse", () => {
  assert.throws(() => rootfsImageName("0123456789"), /12 lowercase hex/);
  assert.throws(() => rootfsImageName("0123456789AB"), /12 lowercase hex/);
  assert.throws(() => rootfsImageName("0123456789ab", "darwin-arm64"), /image platform/);
});

test("imageSizeBytes leaves ext4 metadata room above the content", () => {
  const content = 2 * 1024 ** 3;
  const size = imageSizeBytes(content);
  assert.ok(size > content);
  assert.ok(size >= content + 512 * MIB);
  assert.equal(size % (64 * MIB), 0);
});

test("imageSizeBytes rounds up and never goes below the floor", () => {
  assert.equal(imageSizeBytes(1), MIN_IMAGE_BYTES);
  assert.equal(imageSizeBytes(100 * MIB) % (64 * MIB), 0);
  assert.ok(imageSizeBytes(100 * MIB) >= MIN_IMAGE_BYTES);
  assert.throws(() => imageSizeBytes(0), /positive integer/);
  assert.throws(() => imageSizeBytes(1.5), /positive integer/);
  assert.equal(IMAGE_PLATFORMS.length, 2);
});
