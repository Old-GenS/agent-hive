// The checks the promotion command and the release build share: a rootfs is only accepted for a
// release when its file name, rootfs-info.json and image tree all agree, and a signature only
// counts when it was made by the key the channel trusts.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  isPrereleaseTag,
  parseRootfsName,
  readPublicKey,
  signSums,
  stableVersionFromTag,
  sumsEntry,
  validateRootfs,
  verifySums,
} from "../scripts/release-rootfs.mjs";

const info = { rootfs: "0123456789ab", imageTree: "tree-a", built: "2026-11-22T00:00:00Z" };

test("parseRootfsName reads the id", () => {
  assert.equal(parseRootfsName("hive-rootfs-0123456789ab-linux-x86_64.tar.gz"), "0123456789ab");
});

test("parseRootfsName rejects other assets", () => {
  for (const name of [
    "hive-0.5.6-linux-x86_64.tar.gz",
    "hive-rootfs-0123456789ab-linux-arm64.tar.gz",
    "hive-rootfs-0123-linux-x86_64.tar.gz",
    "rootfs.tar.gz",
  ]) {
    assert.throws(() => parseRootfsName(name), /rootfs file name/);
  }
});

test("validateRootfs accepts a matching rootfs", () => {
  assert.equal(
    validateRootfs({ name: "hive-rootfs-0123456789ab-linux-x86_64.tar.gz", info, imageTree: "tree-a" }),
    "0123456789ab",
  );
});

test("validateRootfs rejects a rootfs from another image tree", () => {
  assert.throws(
    () =>
      validateRootfs({
        name: "hive-rootfs-0123456789ab-linux-x86_64.tar.gz",
        info,
        imageTree: "tree-b",
      }),
    /was built from image\/ tree tree-a, but this release's tree is tree-b/,
  );
});

test("validateRootfs rejects a name that disagrees with rootfs-info.json", () => {
  assert.throws(
    () =>
      validateRootfs({
        name: "hive-rootfs-ba9876543210-linux-x86_64.tar.gz",
        info,
        imageTree: "tree-a",
      }),
    /names rootfs "0123456789ab"/,
  );
});

test("validateRootfs rejects missing or empty metadata", () => {
  const name = "hive-rootfs-0123456789ab-linux-x86_64.tar.gz";
  assert.throws(() => validateRootfs({ name, info: null, imageTree: "tree-a" }), /is missing/);
  assert.throws(() => validateRootfs({ name, info: { rootfs: "0123456789ab" }, imageTree: "tree-a" }), /no imageTree/);
  assert.throws(() => validateRootfs({ name, info, imageTree: "" }), /not in a git checkout/);
});

test("stableVersionFromTag drops the prerelease suffix", () => {
  assert.equal(stableVersionFromTag("v0.5.6-nightly.3"), "0.5.6");
  assert.equal(stableVersionFromTag("0.5.6-nightly.12"), "0.5.6");
  // The old spellings are aliases.
  assert.equal(stableVersionFromTag("v0.5.6-dev.1"), "0.5.6");
  assert.equal(stableVersionFromTag("v0.5.6-beta.2"), "0.5.6");
});

test("stableVersionFromTag rejects releases and other tags", () => {
  for (const tag of ["v0.5.6", "v0.5.6-rc.1", "nightly", "v0.5.6-nightly", "v0.5.6-nightly.x"]) {
    assert.throws(() => stableVersionFromTag(tag), /not a nightly tag/);
  }
});

test("isPrereleaseTag matches the channel's spellings", () => {
  assert.equal(isPrereleaseTag("v0.5.6-nightly.3"), true);
  assert.equal(isPrereleaseTag("v0.5.6-dev.3"), true);
  assert.equal(isPrereleaseTag("v0.5.6-beta.3"), true);
  assert.equal(isPrereleaseTag("v0.5.6"), false);
});

test("sumsEntry finds a file's hash in SHA256SUMS", () => {
  const sums = [
    "1111111111111111111111111111111111111111111111111111111111111111  hive-0.5.6-linux-x86_64.tar.gz",
    "2222222222222222222222222222222222222222222222222222222222222222  hive-rootfs-0123456789ab-linux-x86_64.tar.gz",
    "",
  ].join("\n");
  assert.equal(
    sumsEntry(sums, "hive-rootfs-0123456789ab-linux-x86_64.tar.gz"),
    "2222222222222222222222222222222222222222222222222222222222222222",
  );
  assert.equal(sumsEntry(sums, "other.tar.gz"), undefined);
});

test("verifySums accepts the signing key and rejects tampering or another key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const data = Buffer.from("abcdef  hive-0.5.6-linux-x86_64.tar.gz\n");
  const signature = signSums(data, privateKey.export({ type: "pkcs8", format: "pem" }));
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

  assert.equal(verifySums(data, signature, pem), true);
  assert.equal(verifySums(Buffer.from("tampered\n"), signature, pem), false);
  assert.equal(
    verifySums(data, signature, other.publicKey.export({ type: "spki", format: "pem" }).toString()),
    false,
  );
  assert.equal(verifySums(data, "not base64 at all", pem), false);
});

test("readPublicKey reads the PEM out of src/release-key.ts", () => {
  const pem = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n";
  const source = `export const RELEASE_PUBLIC_KEY = \`${pem}\`;\n`;
  assert.equal(readPublicKey(source, "RELEASE_PUBLIC_KEY"), pem);
  assert.throws(() => readPublicKey(source, "PRERELEASE_PUBLIC_KEY"), /no PRERELEASE_PUBLIC_KEY/);
});
