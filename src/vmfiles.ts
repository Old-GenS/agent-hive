/**
 * Safe access to files in a folder the VM can write: a run's `io/`, `io-export/` and `out/`
 * shares. The VM controls those folders, so any name there can be a symlink the agent planted to
 * make the host read, truncate or follow a host file. Every host read goes through `readVmFile`
 * (`O_NOFOLLOW`, a regular file only, size-capped) and every write through `writeVmFile` (delete
 * the old name first, then create with `O_EXCL`). Host-only data never lives in these folders.
 *
 * The launcher's own folders (`hivectl`-style) are excluded: `vm/hive-vm` handles those.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";

/** Refuse a VM-written file larger than this unless the caller says otherwise. */
export const MAX_VM_FILE = 50 * 1024 * 1024;

/**
 * Read a file from a VM-shared folder. Never follows a symlink, refuses anything that is not a
 * regular file (a FIFO, a device) and anything bigger than `max`, and reads through the descriptor
 * so the content cannot be swapped between the checks and the read.
 */
export function readVmFile(path: string, max = MAX_VM_FILE): string {
  return readVmBytes(path, max).toString("utf8");
}

/** The raw bytes of a VM-written file, with the same checks as `readVmFile` (for patches). */
export function readVmBytes(path: string, max = MAX_VM_FILE): Buffer {
  let fd: number;
  try {
    // O_NONBLOCK: a planted FIFO would otherwise block the open forever; it then fails the
    // regular-file check instead. O_NOFOLLOW: a planted symlink fails with ELOOP.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`not a regular file: ${path}`);
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    if (stat.size > max) throw new Error(`too large: ${path}`);
    const buf = Buffer.alloc(stat.size);
    let bytesRead = 0;
    while (bytesRead < buf.length) {
      const n = readSync(fd, buf, bytesRead, buf.length - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/** Like `readVmFile`, but a missing file is just "". Any other refusal still throws. */
export function readVmFileOrEmpty(path: string, max = MAX_VM_FILE): string {
  try {
    return readVmFile(path, max);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Write a file into a VM-shared folder. The name is deleted first (a symlink or file the VM left
 * is removed, never followed), then recreated with `O_CREAT | O_EXCL`, so the write can never
 * follow a link or truncate an existing host file. A directory is refused, not deleted.
 */
export function writeVmFile(path: string, data: string | Buffer): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (stat?.isDirectory()) throw new Error(`not a file: ${path}`);
  rmSync(path, { force: true });
  writeFileSync(path, data, { flag: "wx", mode: 0o644 });
}

/** Read a VM-written file and put it at `dest`, a host-only path, as a fresh file (`wx`). */
export function copyVmFileOut(src: string, dest: string, max = MAX_VM_FILE): void {
  // Byte for byte: a patch may touch files that aren't UTF-8.
  writeFileSync(dest, readVmBytes(src, max), { flag: "wx", mode: 0o644 });
}
