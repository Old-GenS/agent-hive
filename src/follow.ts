/**
 * Tail a JSONL file by polling. Used for the event log pi writes inside the VM
 * (`/io/events.jsonl`): the file sits on a virtiofs share, where fs.watch is unreliable, so we
 * keep a byte offset and re-read whatever has been appended.
 */
import * as fs from "node:fs";

export function followJsonl(
  path: string,
  onEvent: (event: any) => void,
  intervalMs = 250,
): { poll(): void; stop(): void } {
  let offset = 0;
  let pending = Buffer.alloc(0);

  const poll = () => {
    let fd: number;
    try {
      fd = fs.openSync(path, "r");
    } catch {
      return; // not created yet
    }
    let chunk = Buffer.alloc(0);
    try {
      const size = fs.fstatSync(fd).size;
      const len = size - offset;
      if (len > 0) {
        chunk = Buffer.alloc(len);
        let bytesRead = 0;
        while (bytesRead < len) {
          const n = fs.readSync(fd, chunk, bytesRead, len - bytesRead, offset + bytesRead);
          if (n === 0) break;
          bytesRead += n;
        }
        offset += bytesRead;
        chunk = chunk.subarray(0, bytesRead);
      }
    } finally {
      fs.closeSync(fd);
    }

    pending = Buffer.concat([pending, chunk]);
    let nl: number;
    while ((nl = pending.indexOf(10)) !== -1) {
      let line = pending.subarray(0, nl).toString("utf8");
      pending = pending.subarray(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        onEvent(event);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const timer = setInterval(poll, intervalMs);
  return {
    poll,
    stop() {
      clearInterval(timer);
      poll();
    },
  };
}
