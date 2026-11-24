// The release numbering rules: a nightly previews the next patch, a promotion takes its version
// from the nightly tag, and nothing reads package.json unless no release exists yet.
import test from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  newestRelease,
  nextNightlyVersion,
  nextStableVersion,
  stableVersionFromTag,
} from "../scripts/release-rootfs.mjs";

test("a nightly tag names the stable version it promotes to", () => {
  assert.equal(stableVersionFromTag("v0.5.8-nightly.10"), "0.5.8");
  assert.equal(stableVersionFromTag("0.5.8-nightly.10"), "0.5.8");
  assert.equal(stableVersionFromTag("v0.5.6-dev.2"), "0.5.6");
  assert.equal(stableVersionFromTag("v0.5.6-beta.2"), "0.5.6");
  assert.throws(() => stableVersionFromTag("v0.5.8"), /not a nightly tag/);
  assert.throws(() => stableVersionFromTag("main"), /not a nightly tag/);
});

test("the newest release is the newest version, stable winning a tie", () => {
  assert.deepEqual(newestRelease(["v0.5.7", "v0.5.8-nightly.10"]).version, [0, 5, 8]);
  assert.equal(newestRelease(["v0.5.7", "v0.5.8-nightly.10"]).prerelease, true);
  assert.equal(newestRelease(["v0.5.8", "v0.5.8-nightly.10"]).prerelease, false);
  assert.equal(newestRelease(["v0.5.6-dev.2", "a-tag", "v0.5.5"]).version.join("."), "0.5.6");
  assert.equal(newestRelease([]), undefined);
  assert.equal(newestRelease(["latest", "main"]), undefined);
});

test("a stable release is the patch after the newest release", () => {
  assert.equal(nextStableVersion(["v0.5.8"], "0.5.9"), "0.5.9");
  assert.equal(nextStableVersion(["v0.5.8", "v0.5.8-nightly.10"], "0.5.9"), "0.5.9");
  // The nightlies already preview 0.5.9, so that is the version it releases as.
  assert.equal(nextStableVersion(["v0.5.8", "v0.5.9-nightly.12"], "0.5.9"), "0.5.9");
  // First release ever: package.json is the only thing to go on.
  assert.equal(nextStableVersion([], "0.1.0"), "0.1.0");
  assert.throws(() => nextStableVersion([], undefined), /no release tag/);
});

test("the newest release keeps its tag", () => {
  assert.equal(newestRelease(["v0.5.7", "v0.5.8-nightly.10"]).tag, "v0.5.8-nightly.10");
  assert.equal(newestRelease(["v0.5.8", "v0.5.8-nightly.10"]).tag, "v0.5.8");
});

test("a nightly after a stable release previews the next patch", () => {
  assert.equal(nextNightlyVersion(["v0.5.8"], 11), "0.5.9-nightly.11");
  assert.equal(nextNightlyVersion(["v0.5.8", "v0.5.8-nightly.10"], 11), "0.5.9-nightly.11");
  // 0.5.8 has only been a preview, so the nightlies stay on it until it is released.
  assert.equal(nextNightlyVersion(["v0.5.7", "v0.5.8-nightly.10"], 11), "0.5.8-nightly.11");
});

test("more nightlies keep the preview line they are on", () => {
  assert.equal(nextNightlyVersion(["v0.5.9-nightly.11"], 12), "0.5.9-nightly.12");
  assert.equal(nextNightlyVersion(["v0.5.9-nightly.12", "v0.5.8"], 13), "0.5.9-nightly.13");
});

test("only with no release at all does the nightly count from package.json", () => {
  assert.equal(nextNightlyVersion([], 1, "0.1.0"), "0.1.1-nightly.1");
  assert.throws(() => nextNightlyVersion([], 1), /no release tag/);
});

test("a nightly run number must be a positive integer", () => {
  assert.throws(() => nextNightlyVersion(["v0.5.8"], 0), /run number/);
  assert.throws(() => nextNightlyVersion(["v0.5.8"], 1.5), /run number/);
});

test("versions compare numerically, not as strings", () => {
  assert.equal(compareVersions("0.5.9", "0.5.10"), -1);
  assert.equal(compareVersions("0.5.10", "0.5.9"), 1);
  assert.equal(compareVersions("0.5.8", "0.5.8-nightly.10"), 0);
  assert.throws(() => compareVersions("nope", "0.5.8"), /cannot compare/);
});

test("promoting a nightly is allowed, re-releasing the same version is not", () => {
  // The guard in release.yml: newer wins, the same number only when its own nightly is newest.
  const allowed = (wanted, tags) => {
    const newest = newestRelease(tags);
    if (newest === undefined) return true;
    const cmp = compareVersions(wanted, newest.version.join("."));
    return cmp > 0 || (cmp === 0 && newest.prerelease);
  };
  assert.equal(allowed("0.5.9", ["v0.5.8", "v0.5.9-nightly.12"]), true);
  assert.equal(allowed("0.5.8", ["v0.5.8", "v0.5.8-nightly.10"]), false);
  assert.equal(allowed("0.5.7", ["v0.5.8"]), false);
  assert.equal(allowed("0.5.9", ["v0.5.9"]), false);
});
