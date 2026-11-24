// The release numbering rule: a stable release is the patch after the newest release, and
// package.json is only read when the repository has no release yet.
import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, newestRelease, nextStableVersion } from "../scripts/release-rootfs.mjs";


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





test("versions compare numerically, not as strings", () => {
  assert.equal(compareVersions("0.5.9", "0.5.10"), -1);
  assert.equal(compareVersions("0.5.10", "0.5.9"), 1);
  assert.equal(compareVersions("0.5.8", "0.5.8-nightly.10"), 0);
  assert.throws(() => compareVersions("nope", "0.5.8"), /cannot compare/);
});

