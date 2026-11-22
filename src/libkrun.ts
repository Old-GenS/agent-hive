/**
 * Which libkrun the launcher (`vm/hive-vm`) loads, and how to name it wherever hive reports
 * isolation.
 *
 * The order is fixed (docs/ROADMAP.md, step 2):
 *   1. HIVE_LIBKRUN, when set: the user forces one library;
 *   2. the system's libkrun, so the distro's security updates apply, but only when the launcher's
 *      `--check` passes;
 *   3. the libkrun bundled with a release.
 * The check runs before anything boots a VM, so an old distro libkrun falls through to the bundled
 * one instead of breaking runs.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { bundleRoot } from "./release.js";

export type LibkrunSource = "custom" | "system" | "bundled";

export interface LibkrunCandidate {
  /** What the launcher passes to dlopen(): a bare soname for the system library, else a path. */
  path: string;
  source: LibkrunSource;
}

export interface LibkrunChoice extends LibkrunCandidate {
  /** True when the launcher's `--check` accepted this library. */
  ok: boolean;
}

/** The soname the launcher dlopen()s: libkrun.so.1 on Linux, libkrun.1.dylib on macOS. */
export function libkrunName(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "libkrun.1.dylib" : "libkrun.so.1";
}

/**
 * The libraries to try, in order. HIVE_LIBKRUN is exclusive: when the user names one, hive does
 * not quietly fall back to another. Without it the system soname comes first, then the bundled
 * copy when a release bundle has one.
 */
export function libkrunCandidates(
  env: NodeJS.ProcessEnv,
  bundle: string | undefined,
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): LibkrunCandidate[] {
  const custom = env.HIVE_LIBKRUN;
  if (custom) return [{ path: custom, source: "custom" }];

  const name = libkrunName(platform);
  const candidates: LibkrunCandidate[] = [{ path: name, source: "system" }];
  if (bundle) {
    const bundled = join(bundle, "lib", name);
    if (exists(bundled)) candidates.push({ path: bundled, source: "bundled" });
  }
  return candidates;
}

/** The first candidate the launcher accepts; when none do, the first one with `ok: false`. */
export function pickLibkrun(
  candidates: LibkrunCandidate[],
  check: (path: string) => boolean,
): LibkrunChoice {
  for (const candidate of candidates) {
    if (check(candidate.path)) return { ...candidate, ok: true };
  }
  const first = candidates[0];
  if (!first) throw new Error("no libkrun candidates");
  return { ...first, ok: false };
}

/** True when the launcher can load this library: its `--check` exits 0. */
function launcherAcceptsLibkrun(path: string): boolean {
  if (!existsSync(config.sandbox.vmBin)) return false;
  try {
    execFileSync(config.sandbox.vmBin, ["--check"], {
      env: { ...process.env, HIVE_LIBKRUN: path },
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

let cachedChoice: LibkrunChoice | undefined;

/**
 * The library hive will use. A working choice is kept for the life of the process (the probes are
 * not cheap); a failed one is probed again next time, so a long-running server notices a fix
 * (libkrun installed, /dev/kvm access granted) without a restart.
 */
export function libkrunChoice(): LibkrunChoice {
  if (cachedChoice?.ok) return cachedChoice;
  cachedChoice = pickLibkrun(libkrunCandidates(process.env, bundleRoot()), launcherAcceptsLibkrun);
  return cachedChoice;
}

/** How to name the chosen library in user-facing text: "bundled libkrun", "system libkrun", ... */
export function libkrunLabel(choice: LibkrunCandidate): string {
  switch (choice.source) {
    case "bundled":
      return "bundled libkrun";
    case "system":
      return "system libkrun";
    case "custom":
      return "libkrun from HIVE_LIBKRUN";
  }
}
