// check-updates' pure helpers: the rust and passt parsers, the Containerfile ARG, and applying a
// component update to the release files. No network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyUpdate,
  compareDotted,
  parseContainerfileArg,
  parsePasstTags,
  parseRustVersion,
  setContainerfileArg,
} from "../scripts/check-updates.mjs";

const versionsText = `{
  "libkrun": {
    "version": "1.19.8",
    "repo": "https://github.com/containers/libkrun",
    "tag": "v1.19.8",
    "commit": "c4d283c233bc0ae1993c289ec2a1b4da2242f1f8"
  },
  "libkrunfw": {
    "version": "5.6.2",
    "url": "https://github.com/containers/libkrunfw/releases/download/v5.6.2/libkrunfw-x86_64.tgz",
    "sha256": "016c32ddb2a28aa300382cab33352d63a41a901eb36ee8d1ca24b389791c8b91",
    "source": "https://github.com/containers/libkrunfw/archive/refs/tags/v5.6.2.tar.gz"
  },
  "passt": {
    "version": "2026_10_02.cba3570",
    "url": "https://passt.top/passt/snapshot/passt-2026_10_02.cba3570.tar.xz",
    "sha256": "aa75616cc43925f0bd6c05bcfbbaecd77397c03d7bd23591b34ef535be5dfcdc"
  },
  "rust": "1.99.0",
  "buildImage": "quay.io/pypa/manylinux_2_28_x86_64@sha256:55a36963bc0504cdf004011001c1072306402f0b8b83be5a5eba7068f93eec53",
  "node": "24.18.0"
}
`;

const containerfileText = `# comment
FROM registry.fedoraproject.org/fedora:45
ARG PI_VERSION=1.5.2
RUN npm install -g "@earendil-works/pi-coding-agent@\${PI_VERSION}"
`;

function files() {
  return { "versions.json": versionsText, "image/Containerfile": containerfileText };
}

function readVersions(updated) {
  return JSON.parse(updated["versions.json"]);
}

test("compareDotted compares numbers, not strings", () => {
  assert.equal(compareDotted("1.9.0", "1.10.0"), -1);
  assert.equal(compareDotted("v1.2", "1.2.0"), 0);
  assert.equal(compareDotted("2.0.0", "1.9.9"), 1);
});

test("parseRustVersion reads the first word of [pkg.rust].version", () => {
  const toml = `manifest-version = "2"

[pkg.rust]
version = "1.90.0 (1159e78c4 2025-09-14)"
git_commit_hash = "abc"

[pkg.rust.target.x86_64-unknown-linux-gnu]
available = true
`;
  assert.equal(parseRustVersion(toml), "1.90.0");
  assert.throws(() => parseRustVersion("[pkg.cargo]\nversion = \"1.0\"\n"), /pkg\.rust/);
});

test("parsePasstTags keeps dated tags, newest first", () => {
  const text = [
    "1111111111111111111111111111111111111111\trefs/tags/2026_09_01.aaaaaaaa",
    "2222222222222222222222222222222222222222\trefs/tags/2026_10_02.cba3570",
    "3333333333333333333333333333333333333333\trefs/tags/2026_10_02.cba3570^{}",
    "4444444444444444444444444444444444444444\trefs/tags/not-a-date",
    "5555555555555555555555555555555555555555\trefs/heads/main",
  ].join("\n");
  assert.deepEqual(parsePasstTags(text), ["2026_10_02.cba3570", "2026_09_01.aaaaaaaa"]);
});

test("parseContainerfileArg and setContainerfileArg", () => {
  assert.equal(parseContainerfileArg(containerfileText, "PI_VERSION"), "1.5.2");
  assert.equal(parseContainerfileArg(containerfileText, "MISSING"), undefined);
  const updated = setContainerfileArg(containerfileText, "PI_VERSION", "1.6.0");
  assert.equal(parseContainerfileArg(updated, "PI_VERSION"), "1.6.0");
  // Adds the ARG when it isn't there.
  assert.match(setContainerfileArg("FROM fedora\n", "PI_VERSION", "1.6.0"), /ARG PI_VERSION=1\.6\.0\n/);
});

test("applyUpdate bumps libkrun and keeps the versions.json shape", () => {
  const updated = applyUpdate("libkrun", files(), {
    version: "1.19.9",
    tag: "v1.19.9",
    commit: "abc123",
  });
  const versions = readVersions(updated);
  assert.equal(versions.libkrun.version, "1.19.9");
  assert.equal(versions.libkrun.tag, "v1.19.9");
  assert.equal(versions.libkrun.commit, "abc123");
  assert.equal(versions.libkrun.repo, "https://github.com/containers/libkrun");
  assert.ok(updated["versions.json"].endsWith("}\n"));
  assert.equal(updated["versions.json"], JSON.stringify(versions, null, 2) + "\n");
  assert.equal(updated["image/Containerfile"], containerfileText);
});

test("applyUpdate bumps libkrunfw, passt, rust, buildImage and node", () => {
  const libkrunfw = readVersions(
    applyUpdate("libkrunfw", files(), {
      version: "5.6.4",
      url: "https://example.invalid/libkrunfw.tgz",
      sha256: "f".repeat(64),
      source: "https://example.invalid/source.tar.gz",
    }),
  );
  assert.deepEqual(libkrunfw.libkrunfw, {
    version: "5.6.4",
    url: "https://example.invalid/libkrunfw.tgz",
    sha256: "f".repeat(64),
    source: "https://example.invalid/source.tar.gz",
  });

  const passt = readVersions(
    applyUpdate("passt", files(), {
      version: "2026_11_01.abcdef0",
      url: "https://passt.top/passt/snapshot/passt-2026_11_01.abcdef0.tar.xz",
      sha256: "e".repeat(64),
    }),
  );
  assert.equal(passt.passt.version, "2026_11_01.abcdef0");
  assert.equal(passt.passt.sha256, "e".repeat(64));

  assert.equal(readVersions(applyUpdate("rust", files(), { version: "2.0.0" })).rust, "2.0.0");
  assert.equal(
    readVersions(applyUpdate("buildImage", files(), { image: "quay.io/pypa/manylinux_2_28_x86_64@sha256:abc" }))
      .buildImage,
    "quay.io/pypa/manylinux_2_28_x86_64@sha256:abc",
  );
  assert.equal(readVersions(applyUpdate("node", files(), { version: "24.19.0" })).node, "24.19.0");
});

test("applyUpdate bumps PI_VERSION in the Containerfile", () => {
  const updated = applyUpdate("pi", files(), { version: "1.6.0" });
  assert.equal(parseContainerfileArg(updated["image/Containerfile"], "PI_VERSION"), "1.6.0");
  assert.equal(updated["versions.json"], versionsText);
});

test("applyUpdate rejects an unknown component", () => {
  assert.throws(() => applyUpdate("nope", files(), {}), /unknown component/);
});
