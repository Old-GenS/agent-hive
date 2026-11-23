#!/usr/bin/env node
/**
 * Read KERNEL_REMOTE from a libkrunfw Makefile without GNU make's --eval, which the Linux
 * release build uses. macOS's /usr/bin/make is GNU make 3.81, which predates --eval (GNU make 4),
 * so this expands the simple $(NAME) references the Makefile defines before KERNEL_REMOTE.
 * Exported for the tests.
 *
 * CLI: node scripts/kernel-remote.mjs <Makefile>   (prints the URL)
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The kernel tarball URL a libkrunfw Makefile downloads, with its simple variables expanded. */
export function kernelRemote(text) {
  const vars = new Map();
  for (const m of text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:?]?=\s*(\S+)/gm)) {
    vars.set(m[1], m[2]);
  }
  const line = /^KERNEL_REMOTE\s*[:?]?=\s*(\S+)/m.exec(text);
  if (line === null) throw new Error("no KERNEL_REMOTE in the Makefile");
  let url = line[1];
  for (let i = 0; i < 5 && /\$\(([^)]+)\)/.test(url); i++) {
    url = url.replace(/\$\(([^)]+)\)/g, (_, name) => vars.get(name) ?? "");
  }
  if (!/^https:\/\//.test(url)) throw new Error(`KERNEL_REMOTE did not resolve to an https URL: ${url}`);
  return url;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(kernelRemote(readFileSync(process.argv[2], "utf8")));
  } catch (err) {
    process.stderr.write(`kernel-remote: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
