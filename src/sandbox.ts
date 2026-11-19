/**
 * Runs commands in a throwaway sandbox: a libkrun microVM launched directly by vm/hive-vm inside
 * a pasta network namespace, or a podman container (a krun microVM when the host has KVM,
 * otherwise gVisor or a plain rootless container; see detectRuntime). The sandbox gets only the
 * mounts and env vars passed in; the host's SSH keys, gh login and .env never enter it.
 */
import { spawn, execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { config } from "./config.js";
import { followJsonl } from "./follow.js";

export type Isolation = "microvm" | "gvisor" | "container";

export interface RuntimeInfo {
  runtime?: string; // undefined = podman's default (crun or runc); "libkrun" = direct microVM
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

/** Sandbox memory string ("512m", "1g", "768") in MiB. */
export function parseMemoryMiB(s: string): number {
  const m = /^(\d+)([mg])?$/i.exec(s.trim());
  if (!m) throw new Error(`invalid memory size "${s}" (expected e.g. 512m, 1g or 768)`);
  const n = Number.parseInt(m[1], 10);
  return m[2]?.toLowerCase() === "g" ? n * 1024 : n;
}

/** First IPv4 nameserver in resolv.conf contents, falling back to 1.1.1.1. */
export function hostNameserver(resolvConf: string): string {
  for (const line of resolvConf.split("\n")) {
    const m = /^\s*nameserver\s+(\S+)/.exec(line);
    if (m && isIPv4(m[1])) return m[1];
  }
  return "1.1.1.1";
}

function resolvConf(): string {
  try {
    return readFileSync("/etc/resolv.conf", "utf8");
  } catch {
    return "";
  }
}

/** True when the direct libkrun backend can run: /dev/kvm, launcher, rootfs, pasta and libkrun. */
export function libkrunAvailable(): boolean {
  try {
    if (!kvmUsable()) return false;
    if (!existsSync(config.sandbox.vmBin)) return false;
    if (!existsSync(join(realpathSync(config.sandbox.rootfs), "usr/local/bin/hive-vm-init"))) return false;
    if (!onPath("pasta")) return false;
    execFileSync(config.sandbox.vmBin, ["--check"], {
      env: { ...process.env, HIVE_LIBKRUN: config.sandbox.libkrun },
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function detectRuntime(): RuntimeInfo {
  const wanted = config.sandbox.runtime;
  if (wanted === "libkrun") return { runtime: "libkrun", isolation: "microvm" };
  if (wanted === "krun") return { runtime: "krun", isolation: "microvm" };
  if (wanted === "runsc") return { runtime: "runsc", isolation: "gvisor" };
  if (wanted === "crun" || wanted === "runc") return { runtime: wanted, isolation: "container", warning: CONTAINER_WARNING };
  if (wanted !== "auto") throw new Error(`HIVE_RUNTIME must be auto, libkrun, krun, runsc, crun or runc (got "${wanted}")`);
  if (libkrunAvailable()) return { runtime: "libkrun", isolation: "microvm" };
  if (kvmUsable() && onPath("krun")) return { runtime: "krun", isolation: "microvm" };
  return {
    isolation: "container",
    warning: (kvmUsable() ? "/dev/kvm exists but krun is not installed. " : "No usable /dev/kvm. ") + CONTAINER_WARNING,
  };
}

export const runtimeInfo = detectRuntime();

export interface SandboxOptions {
  name: string;
  /** host path → container path; ro mounts get ":ro", shared mounts the SELinux ":z" label */
  mounts: { host: string; container: string; ro?: boolean; shared?: boolean }[];
  /** env vars to pass in, name → value. Passed via the child's env, never on the command line. */
  env: Record<string, string>;
  command: string[];
  /** called for each stdout line that parses as JSON */
  onEvent?: (event: any) => void;
  /**
   * libkrun only: a host folder mounted at /io. The command's stdout and stderr go to
   * /io/events.jsonl and /io/stderr.log, and onEvent follows that file, because the VM console
   * doesn't carry pi's JSONL stream reliably (the CLI does the same).
   */
  ioDir?: string;
}

export interface SandboxHandle {
  done: Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
  stop: () => Promise<void>;
}

const MAX_KEPT_OUTPUT = 64 * 1024;

/** pasta + hive-vm argv; env values travel via the child's env, never here. */
export function buildLibkrunCommand(
  opts: SandboxOptions,
  p: { vmBin: string; rootfs: string; cpus: number; memoryMiB: number; hostDns: string },
): { file: string; args: string[] } {
  const args = [
    "--config-net", "-q", "-T", "none", "-U", "none", "--no-map-gw",
    "--dns-forward", "169.254.1.53", "--dns-host", p.hostDns,
    "--", "/usr/bin/env", p.vmBin,
    "--rootfs", p.rootfs, "--cpus", String(p.cpus), "--memory", String(p.memoryMiB),
  ];
  for (const m of opts.mounts) args.push("--share", `${m.host}:${m.container}${m.ro ? ":ro" : ""}`);
  for (const name of Object.keys(opts.env)) args.push("--env", name);
  args.push("--dns", "169.254.1.53", "--workdir", "/work", "--", ...opts.command);
  return { file: "pasta", args };
}

function spawnLibkrun(opts: SandboxOptions) {
  const { sandbox } = config;
  const cmd = buildLibkrunCommand(opts, {
    vmBin: sandbox.vmBin,
    rootfs: realpathSync(sandbox.rootfs),
    cpus: Number.parseInt(sandbox.cpus, 10),
    memoryMiB: parseMemoryMiB(sandbox.memory),
    hostDns: hostNameserver(resolvConf()),
  });
  // The launcher reads HIVE_LIBKRUN from its own env.
  return spawn(cmd.file, cmd.args, {
    env: { ...process.env, ...opts.env, HIVE_LIBKRUN: sandbox.libkrun },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

function spawnPodman(opts: SandboxOptions) {
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
  // A shared mount needs the ":z" label: the npm cache is mounted into several sandboxes at once.
  for (const m of opts.mounts) args.push("-v", `${m.host}:${m.container}:${m.ro ? "ro," : ""}${m.shared ? "z" : "Z"}`);
  for (const name of Object.keys(opts.env)) args.push("-e", name);
  args.push("-w", "/work", sandbox.image, ...opts.command);
  return spawn("podman", args, {
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

export function runSandbox(opts: SandboxOptions): SandboxHandle {
  const { sandbox } = config;
  const libkrun = runtimeInfo.runtime === "libkrun";
  let launch = opts;
  let follower: { poll(): void; stop(): void } | undefined;
  const ioDir = libkrun ? opts.ioDir : undefined;
  if (ioDir) {
    rmSync(ioDir, { recursive: true, force: true });
    mkdirSync(ioDir, { recursive: true });
    writeFileSync(join(ioDir, "events.jsonl"), "");
    writeFileSync(join(ioDir, "stderr.log"), "");
    launch = {
      ...opts,
      mounts: [...opts.mounts, { host: ioDir, container: "/io" }],
      command: ["bash", "-c", 'exec "$@" > /io/events.jsonl 2> /io/stderr.log', "hive-io", ...opts.command],
    };
    if (opts.onEvent) {
      const onEvent = opts.onEvent;
      follower = followJsonl(join(ioDir, "events.jsonl"), (event) => {
        try {
          onEvent(event);
        } catch (err) {
          console.error("sandbox onEvent handler failed:", err);
        }
      });
    }
  }
  const child = libkrun ? spawnLibkrun(launch) : spawnPodman(launch);

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
  let hitTimeout = false;
  const timer = libkrun
    ? setTimeout(() => {
        hitTimeout = true;
        killGroup(child.pid, "SIGKILL");
      }, sandbox.timeoutMin * 60_000)
    : undefined;

  const done = new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      follower?.stop();
      resolve({ code: 127, stdout: stdoutTail, stderr: `${stderrTail}\n${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      // stop() does a last poll, so events written just before exit still arrive.
      follower?.stop();
      if (ioDir) stderrTail = keep(stderrTail, readTail(join(ioDir, "stderr.log"), MAX_KEPT_OUTPUT));
      if (pending.length) stdoutTail = keep(stdoutTail, pending.toString("utf8"));
      const timedOut = hitTimeout || (code !== 0 && Date.now() - started >= sandbox.timeoutMin * 60_000);
      resolve({ code: code ?? 1, stdout: stdoutTail, stderr: stderrTail, timedOut });
    });
  });

  const stop = async () => {
    if (libkrun) {
      if (child.exitCode !== null) return;
      killGroup(child.pid, "SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (child.exitCode === null) killGroup(child.pid, "SIGKILL");
          resolve();
        }, 3000);
        child.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
      return;
    }
    await new Promise<void>((resolve) => {
      const p = spawn("podman", ["stop", "-t", "3", opts.name], { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
    if (child.exitCode === null) child.kill("SIGKILL");
  };

  return { done, stop };
}

/** The last `max` bytes of a file the VM wrote, without following symlinks; "" if unreadable. */
function readTail(path: string, max: number): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, size - len);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Startup self-check: the chosen runtime's launcher/image present. Returns problems found. */
export function checkSandbox(): string[] {
  const problems: string[] = [];
  if (runtimeInfo.runtime === "libkrun") {
    if (!existsSync(config.sandbox.vmBin)) {
      problems.push(`libkrun launcher ${config.sandbox.vmBin} not found; build it with: npm run build:vm`);
    }
    if (!existsSync(config.sandbox.rootfs)) {
      problems.push(`libkrun rootfs ${config.sandbox.rootfs} not found; create it with: npm run build:rootfs`);
    }
    return problems;
  }
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
