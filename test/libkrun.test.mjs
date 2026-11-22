// The libkrun backend scan: candidate order (HIVE_LIBKRUN, system, bundled), picking the first
// one the launcher accepts, and the label used wherever hive reports isolation.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// Before the dist modules load: no installed-release env should leak into the test process.
delete process.env.HIVE_BUNDLE_ROOT;
delete process.env.HIVE_LIBKRUN;

const { libkrunCandidates, libkrunLabel, pickLibkrun } = await import("../dist/libkrun.js");

const BUNDLE = "/opt/hive";

test("libkrunCandidates: HIVE_LIBKRUN is the only candidate when set", () => {
  assert.deepEqual(libkrunCandidates({ HIVE_LIBKRUN: "/custom/libkrun.so.1" }, BUNDLE, () => true, "linux"), [
    { path: "/custom/libkrun.so.1", source: "custom" },
  ]);
});

test("libkrunCandidates: without a bundle the system libkrun is the only one", () => {
  assert.deepEqual(libkrunCandidates({}, undefined, undefined, "linux"), [{ path: "libkrun.so.1", source: "system" }]);
});

test("libkrunCandidates: a bundle whose libkrun exists comes after the system one", () => {
  const bundled = join(BUNDLE, "lib", "libkrun.so.1");
  assert.deepEqual(libkrunCandidates({}, BUNDLE, (p) => p === bundled, "linux"), [
    { path: "libkrun.so.1", source: "system" },
    { path: bundled, source: "bundled" },
  ]);
});

test("libkrunCandidates: a bundle without libkrun is skipped", () => {
  assert.deepEqual(libkrunCandidates({}, BUNDLE, () => false, "linux"), [{ path: "libkrun.so.1", source: "system" }]);
});

test("pickLibkrun takes the first candidate the launcher accepts", () => {
  const candidates = libkrunCandidates({}, BUNDLE, () => true, "linux");
  assert.deepEqual(pickLibkrun(candidates, (p) => p === "libkrun.so.1"), {
    path: "libkrun.so.1",
    source: "system",
    ok: true,
  });
  assert.deepEqual(pickLibkrun(candidates, (p) => p !== "libkrun.so.1"), {
    path: join(BUNDLE, "lib", "libkrun.so.1"),
    source: "bundled",
    ok: true,
  });
});

test("pickLibkrun: none accepted gives the first candidate with ok false", () => {
  const candidates = libkrunCandidates({}, BUNDLE, () => true, "linux");
  assert.deepEqual(pickLibkrun(candidates, () => false), {
    path: "libkrun.so.1",
    source: "system",
    ok: false,
  });
});

test("libkrunCandidates: macOS uses libkrun.1.dylib, system and bundled", () => {
  assert.deepEqual(libkrunCandidates({}, undefined, () => false, "darwin"), [
    { path: "libkrun.1.dylib", source: "system" },
  ]);
  const bundled = join(BUNDLE, "lib", "libkrun.1.dylib");
  assert.deepEqual(libkrunCandidates({}, BUNDLE, (p) => p === bundled, "darwin"), [
    { path: "libkrun.1.dylib", source: "system" },
    { path: bundled, source: "bundled" },
  ]);
});

test("libkrunLabel names every source", () => {
  assert.equal(libkrunLabel({ path: "libkrun.so.1", source: "system" }), "system libkrun");
  assert.equal(libkrunLabel({ path: "/opt/hive/lib/libkrun.so.1", source: "bundled" }), "bundled libkrun");
  assert.equal(libkrunLabel({ path: "/custom/libkrun.so.1", source: "custom" }), "libkrun from HIVE_LIBKRUN");
});
