// The pasta scan for the libkrun backend: the system pasta first (distro security updates, the
// AppArmor profile Ubuntu's package installs), then the static copy bundled with a release for
// distros that don't package passt. Picking the first one that runs and the label used wherever
// hive reports network isolation are covered here too.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// Before the dist modules load: no installed-release env should leak into the test process.
delete process.env.HIVE_BUNDLE_ROOT;

const { pastaCandidates, pastaLabel, pickPasta } = await import("../dist/pasta.js");

const BUNDLE = "/opt/hive";

test("pastaCandidates: a system pasta on PATH is the only candidate without a bundle", () => {
  assert.deepEqual(pastaCandidates(undefined, () => "/usr/bin/pasta"), [
    { path: "/usr/bin/pasta", source: "system" },
  ]);
});

test("pastaCandidates: the bundled pasta comes after the system one", () => {
  const bundled = join(BUNDLE, "libexec", "pasta");
  assert.deepEqual(pastaCandidates(BUNDLE, () => "/usr/bin/pasta", (p) => p === bundled), [
    { path: "/usr/bin/pasta", source: "system" },
    { path: bundled, source: "bundled" },
  ]);
});

test("pastaCandidates: the bundled pasta is used when there is no system pasta", () => {
  const bundled = join(BUNDLE, "libexec", "pasta");
  assert.deepEqual(pastaCandidates(BUNDLE, () => undefined, (p) => p === bundled), [
    { path: bundled, source: "bundled" },
  ]);
});

test("pastaCandidates: a bundle without a pasta is skipped", () => {
  assert.deepEqual(pastaCandidates(BUNDLE, () => undefined, () => false), []);
  assert.deepEqual(pastaCandidates(undefined, () => undefined, () => true), []);
});

test("pickPasta takes the first candidate that runs", () => {
  const candidates = pastaCandidates(BUNDLE, () => "/usr/bin/pasta", () => true);
  assert.deepEqual(pickPasta(candidates, (p) => p === "/usr/bin/pasta"), {
    path: "/usr/bin/pasta",
    source: "system",
    ok: true,
  });
  assert.deepEqual(pickPasta(candidates, () => true), {
    path: "/usr/bin/pasta",
    source: "system",
    ok: true,
  });
});

test("pickPasta: a broken system pasta falls through to the bundled one", () => {
  const candidates = pastaCandidates(BUNDLE, () => "/usr/bin/pasta", () => true);
  assert.deepEqual(pickPasta(candidates, (p) => p === join(BUNDLE, "libexec", "pasta")), {
    path: join(BUNDLE, "libexec", "pasta"),
    source: "bundled",
    ok: true,
  });
});

test("pickPasta: none runs gives the first candidate with ok false", () => {
  const candidates = pastaCandidates(BUNDLE, () => "/usr/bin/pasta", () => true);
  assert.deepEqual(pickPasta(candidates, () => false), {
    path: "/usr/bin/pasta",
    source: "system",
    ok: false,
  });
});

test("pickPasta: an empty candidate list still names a pasta to probe", () => {
  assert.deepEqual(pickPasta([], () => true), { path: "pasta", source: "system", ok: false });
});

test("pastaLabel names every source", () => {
  assert.equal(pastaLabel({ path: "/usr/bin/pasta", source: "system" }), "system pasta");
  assert.equal(pastaLabel({ path: "/opt/hive/libexec/pasta", source: "bundled" }), "bundled pasta");
});
