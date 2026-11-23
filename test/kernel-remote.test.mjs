// The libkrunfw Makefile's KERNEL_REMOTE, read without GNU make (the macOS release build).
import test from "node:test";
import assert from "node:assert/strict";
import { kernelRemote } from "../scripts/kernel-remote.mjs";

test("kernelRemote expands the Makefile's simple variables", () => {
  const makefile = `KERNEL_VERSION = linux-6.12.109
KERNEL_REMOTE = https://cdn.kernel.org/pub/linux/kernel/v6.x/$(KERNEL_VERSION).tar.xz
KERNEL_TARBALL = tarballs/$(KERNEL_VERSION).tar.xz
`;
  assert.equal(
    kernelRemote(makefile),
    "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.109.tar.xz",
  );
});

test("kernelRemote handles ?= and := assignments", () => {
  assert.equal(
    kernelRemote("VERSION := 6.12.1\nREMOTE ?= https://example.test/linux-$(VERSION).tar.xz\nKERNEL_REMOTE = $(REMOTE)\n"),
    "https://example.test/linux-6.12.1.tar.xz",
  );
});

test("kernelRemote rejects a missing or non-https remote", () => {
  assert.throws(() => kernelRemote("VERSION = 1\n"), /KERNEL_REMOTE/);
  assert.throws(() => kernelRemote("KERNEL_REMOTE = ftp://example.test/x\n"), /https/);
});
