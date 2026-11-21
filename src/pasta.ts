/**
 * Which pasta hive runs each microVM under, and how to name it wherever hive reports network
 * isolation.
 *
 * The order mirrors src/libkrun.ts:
 *   1. the system's pasta, so the distro's security updates apply (and on Ubuntu 24.04+ the
 *      AppArmor profile its `passt` package installs lets pasta create the user namespace it
 *      needs);
 *   2. the static pasta bundled with a release, for distros that don't package passt (Ubuntu
 *      22.04 / Mint 21, Debian 11, RHEL 8).
 * The check runs before anything boots a VM, so a system pasta that is present but won't run
 * falls through to the bundled one instead of breaking runs.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { bundleRoot } from "./release.js";

export type PastaSource = "system" | "bundled";

export interface PastaCandidate {
  /** An absolute path to the pasta binary. */
  path: string;
  source: PastaSource;
}

export interface PastaChoice extends PastaCandidate {
  /** True when `pasta --version` exits 0. */
  ok: boolean;
}

/** Absolute path of an executable on PATH, or undefined. */
export function commandPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here (or not executable): keep looking.
    }
  }
  return undefined;
}

/**
 * The pasta binaries to try, in order: the system one when PATH has one, then the copy bundled
 * with a release. A bundle without a pasta is skipped.
 */
export function pastaCandidates(
  bundle: string | undefined,
  onPath: (cmd: string) => string | undefined,
  exists: (p: string) => boolean = existsSync,
): PastaCandidate[] {
  const candidates: PastaCandidate[] = [];
  const system = onPath("pasta");
  if (system) candidates.push({ path: system, source: "system" });
  if (bundle) {
    const bundled = join(bundle, "libexec", "pasta");
    if (exists(bundled)) candidates.push({ path: bundled, source: "bundled" });
  }
  return candidates;
}

/** The first candidate that runs; when none do, the first one with `ok: false`. */
export function pickPasta(candidates: PastaCandidate[], works: (path: string) => boolean): PastaChoice {
  for (const candidate of candidates) {
    if (works(candidate.path)) return { ...candidate, ok: true };
  }
  const first = candidates[0] ?? { path: "pasta", source: "system" as const };
  return { ...first, ok: false };
}

/** True when this pasta runs: its `--version` exits 0. */
function pastaWorks(path: string): boolean {
  try {
    return spawnSync(path, ["--version"], { timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
}

let cachedChoice: PastaChoice | undefined;

/**
 * The pasta hive will use. A working choice is kept for the life of the process (the probes are
 * not cheap); a failed one is probed again next time, so a long-running server notices a fix
 * (passt installed, the bundle repaired) without a restart.
 */
export function pastaChoice(): PastaChoice {
  if (cachedChoice?.ok) return cachedChoice;
  cachedChoice = pickPasta(pastaCandidates(bundleRoot(), commandPath), pastaWorks);
  return cachedChoice;
}

/** How to name the chosen pasta in user-facing text: "system pasta", "bundled pasta". */
export function pastaLabel(choice: PastaCandidate): string {
  return choice.source === "bundled" ? "bundled pasta" : "system pasta";
}
