/**
 * Runs commands in a throwaway podman sandbox: a krun microVM when the host has KVM, otherwise
 * gVisor or a plain rootless container (see detectRuntime). The sandbox gets only the mounts and
 * env vars passed in; the host's SSH keys, gh login and .env never enter it.
 */
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { config } from "./config.js";

export type Isolation = "microvm" | "gvisor" | "container";

export interface RuntimeInfo {
  runtime?: string; // undefined = podman's default (crun or runc)
  isolation: Isolation;
  warning?: string;
}

function onPath(bin: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function kvmUsable(): boolean {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const CONTAINER_WARNING =
  "Sandboxes run as plain rootless containers that share the host kernel. A kernel exploit " +
  "would escape to the user running podman, so run agent-hive as a user with no other secrets, " +
  "or use a host with /dev/kvm (krun) or install gVisor (HIVE_RUNTIME=runsc).";

export function detectRuntime(): RuntimeInfo {
  const wanted = config.sandbox.runtime;
  if (wanted === "krun") return { runtime: "krun", isolation: "microvm" };
  if (wanted === "runsc") return { runtime: "runsc", isolation: "gvisor" };
  if (wanted === "crun" || wanted === "runc") return { runtime: wanted, isolation: "container", warning: CONTAINER_WARNING };
  if (wanted !== "auto") throw new Error(`HIVE_RUNTIME must be auto, krun, runsc, crun or runc (got "${wanted}")`);
  if (kvmUsable() && onPath("krun")) return { runtime: "krun", isolation: "microvm" };
  return {
    isolation: "container",
    warning: (kvmUsable() ? "/dev/kvm exists but krun is not installed. " : "No usable /dev/kvm. ") + CONTAINER_WARNING,
  };
}

export const runtimeInfo = detectRuntime();

export interface SandboxOptions {
  name: string;
  /** host path → container path; ro mounts get ":ro" */
  mounts: { host: string; container: string; ro?: boolean }[];
  /** env vars to pass in, name → value. Passed via the child's env, never on the command line. */
  env: Record<string, string>;
  command: string[];
  /** called for each stdout line that parses as JSON */
  onEvent?: (event: any) => void;
}

export interface SandboxHandle {
  done: Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
  stop: () => Promise<void>;
}

const MAX_KEPT_OUTPUT = 64 * 1024;

export function runSandbox(opts: SandboxOptions): SandboxHandle {
  const { sandbox } = config;
  const args = ["run", "--rm", "--name", opts.name];
  if (runtimeInfo.runtime) args.push("--runtime", runtimeInfo.runtime);
  args.push(
    "--memory", sandbox.memory,
    "--cpus", sandbox.cpus,
    "--pids-limit", "4096",
    "--timeout", String(sandbox.timeoutMin * 60),
    "--security-opt", "no-new-privileges",
    // The output is read from the attached stdout; don't also copy transcripts into journald.
    "--log-driver", "none",
  );
  for (const m of opts.mounts) args.push("-v", `${m.host}:${m.container}:${m.ro ? "ro," : ""}Z`);
  for (const name of Object.keys(opts.env)) args.push("-e", name);
  args.push("-w", "/work", sandbox.image, ...opts.command);

  const child = spawn("podman", args, {
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutTail = "";
  let stderrTail = "";
  let pending = Buffer.alloc(0);
  const keep = (tail: string, more: string) => (tail + more).slice(-MAX_KEPT_OUTPUT);

  // pi's stream is strict JSONL: split on LF only (not readline, which also splits on U+2028).
  child.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let nl: number;
    while ((nl = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      pending = pending.subarray(nl + 1);
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        stdoutTail = keep(stdoutTail, line + "\n");
        continue;
      }
      try {
        opts.onEvent?.(event);
      } catch (err) {
        console.error("sandbox onEvent handler failed:", err);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = keep(stderrTail, chunk.toString("utf8"));
  });

  const started = Date.now();
  const done = new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    child.on("error", (err) => resolve({ code: 127, stdout: stdoutTail, stderr: `${stderrTail}\n${err.message}`, timedOut: false }));
    child.on("close", (code) => {
      if (pending.length) stdoutTail = keep(stdoutTail, pending.toString("utf8"));
      const timedOut = code !== 0 && Date.now() - started >= sandbox.timeoutMin * 60_000;
      resolve({ code: code ?? 1, stdout: stdoutTail, stderr: stderrTail, timedOut });
    });
  });

  const stop = async () => {
    await new Promise<void>((resolve) => {
      const p = spawn("podman", ["stop", "-t", "3", opts.name], { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
    if (child.exitCode === null) child.kill("SIGKILL");
  };

  return { done, stop };
}

/** Startup self-check: podman present and the sandbox image built. Returns problems found. */
export function checkSandbox(): string[] {
  const problems: string[] = [];
  if (!onPath("podman")) {
    problems.push("podman is not installed; no task can run.");
    return problems;
  }
  try {
    execFileSync("podman", ["image", "exists", config.sandbox.image], { stdio: "ignore" });
  } catch {
    problems.push(`sandbox image ${config.sandbox.image} not found; build it with: npm run build:image`);
  }
  return problems;
}
