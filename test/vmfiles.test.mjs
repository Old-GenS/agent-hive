// The safe reader/writer for VM-shared folders: never follow a symlink, never block on a FIFO,
// cap the size, and always create fresh files instead of writing through a planted name.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { copyVmFileOut, readVmFile, readVmFileOrEmpty, writeVmFile } = await import("../dist/vmfiles.js");

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const hasMkfifo = (() => {
  try {
    execFileSync("sh", ["-c", "command -v mkfifo"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("readVmFile reads a regular file", () => {
  const dir = tempDir("hive-vmfiles-read-");
  const path = join(dir, "events.jsonl");
  writeFileSync(path, '{"type":"message_end"}\n');
  assert.equal(readVmFile(path), '{"type":"message_end"}\n');
  assert.equal(readVmFile(path, 1024), '{"type":"message_end"}\n');
});

test("readVmFile refuses a symlink to a real file and never returns its content", () => {
  const dir = tempDir("hive-vmfiles-link-");
  const secret = join(dir, "secret");
  writeFileSync(secret, "host secret");
  const link = join(dir, "events.jsonl");
  symlinkSync(secret, link);
  assert.throws(() => readVmFile(link), /not a regular file/);
});

test("readVmFile refuses a FIFO without hanging", { skip: hasMkfifo ? false : "mkfifo is not installed" }, () => {
  const dir = tempDir("hive-vmfiles-fifo-");
  const fifo = join(dir, "events.jsonl");
  execFileSync("mkfifo", [fifo]);
  // No writer ever opens the FIFO: a plain open would block, O_NONBLOCK returns at once and the
  // regular-file check then refuses it.
  assert.throws(() => readVmFile(fifo), /not a regular file/);
});

test("readVmFile refuses a file bigger than max", () => {
  const dir = tempDir("hive-vmfiles-big-");
  const path = join(dir, "big.log");
  writeFileSync(path, "x".repeat(20));
  assert.throws(() => readVmFile(path, 10), /too large/);
});

test("readVmFileOrEmpty returns '' for a missing file and throws for a symlink", () => {
  const dir = tempDir("hive-vmfiles-empty-");
  assert.equal(readVmFileOrEmpty(join(dir, "missing")), "");
  const secret = join(dir, "secret");
  writeFileSync(secret, "host secret");
  const link = join(dir, "link");
  symlinkSync(secret, link);
  assert.throws(() => readVmFileOrEmpty(link), /not a regular file/);
});

test("writeVmFile replaces a planted symlink with a fresh file and leaves the target alone", () => {
  const dir = tempDir("hive-vmfiles-write-");
  const hostFile = join(dir, "host-file");
  writeFileSync(hostFile, "host data");
  const planted = join(dir, "system.md");
  symlinkSync(hostFile, planted);

  writeVmFile(planted, "new content");

  assert.equal(lstatSync(planted).isFile(), true, "the symlink was replaced by a regular file");
  assert.equal(lstatSync(planted).isSymbolicLink(), false);
  assert.equal(readFileSync(planted, "utf8"), "new content");
  assert.equal(readFileSync(hostFile, "utf8"), "host data", "the symlink target was not written");
});

test("writeVmFile refuses a directory instead of deleting it", () => {
  const dir = tempDir("hive-vmfiles-dir-");
  const sub = join(dir, "system.md");
  mkdirSync(sub);
  assert.throws(() => writeVmFile(sub, "x"), /not a file/);
  assert.equal(lstatSync(sub).isDirectory(), true);
});

test("copyVmFileOut copies regular files and refuses a symlinked source", () => {
  const dir = tempDir("hive-vmfiles-copy-");
  const src = join(dir, "0001.patch");
  writeFileSync(src, "patch\n");
  const dest = join(tempDir("hive-vmfiles-out-"), "0001.patch");
  copyVmFileOut(src, dest);
  assert.equal(readFileSync(dest, "utf8"), "patch\n");

  const secret = join(dir, "secret");
  writeFileSync(secret, "host secret");
  const link = join(dir, "planted.patch");
  symlinkSync(secret, link);
  assert.throws(() => copyVmFileOut(link, join(tempDir("hive-vmfiles-out-"), "planted.patch")), /not a regular file/);
});
