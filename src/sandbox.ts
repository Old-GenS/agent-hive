/**
 * Runs commands in a throwaway sandbox: a libkrun microVM launched directly by vm/hive-vm inside
 * a pasta network namespace. The sandbox gets only the mounts and env vars passed in; the host's
 * SSH keys, gh login and .env never enter it.
 */
import { spawn, execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { config } from "./config.js";
import { followJsonl } from "./follow.js";

export type Isolation = "microvm" | "unavailable";

export interface RuntimeInfo {
  runtime: "libkrun";
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
  if (wanted !== "auto" && wanted !== "libkrun") {
    throw new Error(`HIVE_RUNTIME must be auto or libkrun (got "${wanted}")`);
  }
  if (libkrunAvailable()) return { runtime: "libkrun", isolation: "microvm" };
  const problems = checkSandbox();
  return {
    runtime: "libkrun",
    isolation: "unavailable",
    warning: problems.length
      ? problems.join(" ")
      : "libkrun is not available: a microVM needs /dev/kvm, pasta, libkrun, the launcher and the rootfs.",
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
  /** called for each event in io/events.jsonl */
  onEvent?: (event: any) => void;
  /**
   * A host folder mounted at /io. The command's stdout and stderr go to /io/events.jsonl and
   * /io/stderr.log, and onEvent follows that file, because the VM console doesn't carry pi's
   * JSONL stream reliably (the CLI does the same).
   */
  ioDir: string;
}

export interface SandboxHandle {
  done: Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
  stop: () => Promise<void>;
}

const MAX_KEPT_OUTPUT = 64 * 1024;

/** pasta + hive-vm argv; env values travel via the child's env, never here. */
export function buildLibkrunCommand(
  opts: SandboxOptions,
  p: { vmBin: string; rootfs: string; cpus: number; memoryMiB: number; hostDns: string; timeoutSec: number },
): { file: string; args: string[] } {
  const args = [
    "--config-net", "-q", "-T", "none", "-U", "none", "--no-map-gw",
    "--dns-forward", "169.254.1.53", "--dns-host", p.hostDns,
    "--", "/usr/bin/env", p.vmBin,
    "--rootfs", p.rootfs, "--cpus", String(p.cpus), "--memory", String(p.memoryMiB),
    "--timeout", String(p.timeoutSec),
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
    timeoutSec: sandbox.timeoutMin * 60,
  });
  // The launcher reads HIVE_LIBKRUN from its own env.
  return spawn(cmd.file, cmd.args, {
    env: { ...process.env, ...opts.env, HIVE_LIBKRUN: sandbox.libkrun },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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

/**
 * Prepare a run's /io folder: keep it (the caller may have put prompt files there) but start the
 * two logs fresh. They are unlinked first: the VM controls this folder, and writing through a
 * symlink it planted would truncate a host file.
 */
export function resetIoDir(ioDir: string): void {
  mkdirSync(ioDir, { recursive: true });
  for (const name of ["events.jsonl", "stderr.log"]) {
    rmSync(join(ioDir, name), { force: true });
    writeFileSync(join(ioDir, name), "", { flag: "wx" });
  }
}

export function runSandbox(opts: SandboxOptions): SandboxHandle {
  const { sandbox } = config;
  const ioDir = opts.ioDir;
  resetIoDir(ioDir);
  const launch: SandboxOptions = {
    ...opts,
    mounts: [...opts.mounts, { host: ioDir, container: "/io" }],
    command: ["bash", "-c", 'exec "$@" > /io/events.jsonl 2> /io/stderr.log', "hive-io", ...opts.command],
  };
  let follower: { poll(): void; stop(): void } | undefined;
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
  const child = spawnLibkrun(launch);

  // Stdout and stderr are only kept as a tail for error messages; events come from io/events.jsonl.
  let stdoutTail = "";
  let stderrTail = "";
  const keep = (tail: string, more: string) => (tail + more).slice(-MAX_KEPT_OUTPUT);
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutTail = keep(stdoutTail, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = keep(stderrTail, chunk.toString("utf8"));
  });

  const started = Date.now();
  let hitTimeout = false;
  const timer = setTimeout(() => {
    hitTimeout = true;
    killGroup(child.pid, "SIGKILL");
  }, sandbox.timeoutMin * 60_000);

  const done = new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    child.on("error", (err) => {
      clearTimeout(timer);
      follower?.stop();
      resolve({ code: 127, stdout: stdoutTail, stderr: `${stderrTail}\n${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // stop() does a last poll, so events written just before exit still arrive.
      follower?.stop();
      stderrTail = keep(stderrTail, readTail(join(ioDir, "stderr.log"), MAX_KEPT_OUTPUT));
      const timedOut = hitTimeout || code === 124 || (code !== 0 && Date.now() - started >= sandbox.timeoutMin * 60_000);
      resolve({ code: code ?? 1, stdout: stdoutTail, stderr: stderrTail, timedOut });
    });
  });

  const stop = async () => {
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

export interface SystemCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** What the server runs sandboxes with, plus the checks behind it, for the UI's "This computer". */
export function systemInfo(): {
  isolation: RuntimeInfo["isolation"];
  runtime: string;
  warning?: string;
  checks: SystemCheck[];
} {
  const checks: SystemCheck[] = [];
  let kvm = "ok";
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch (err) {
    kvm = (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "no access";
  }
  checks.push({ name: "Hardware virtualization", ok: kvm === "ok", detail: kvm === "ok" ? "/dev/kvm" : `/dev/kvm: ${kvm}` });
  const launcher = existsSync(config.sandbox.vmBin);
  let libkrun = false;
  if (launcher) {
    try {
      execFileSync(config.sandbox.vmBin, ["--check"], {
        env: { ...process.env, HIVE_LIBKRUN: config.sandbox.libkrun },
        stdio: "ignore",
      });
      libkrun = true;
    } catch {
      libkrun = false;
    }
  }
  checks.push({ name: "libkrun (starts the VM)", ok: libkrun, detail: config.sandbox.libkrun });
  checks.push({ name: "pasta (network isolation)", ok: onPath("pasta"), detail: "VMs reach the internet, not this computer or the local network" });
  checks.push({ name: "VM launcher", ok: launcher, detail: config.sandbox.vmBin });
  let rootfs = config.sandbox.rootfs;
  let rootfsOk = false;
  try {
    rootfs = realpathSync(config.sandbox.rootfs);
    rootfsOk = existsSync(join(rootfs, "usr/local/bin/hive-vm-init"));
  } catch {
    rootfsOk = false;
  }
  checks.push({ name: "VM filesystem", ok: rootfsOk, detail: rootfs });
  return { isolation: runtimeInfo.isolation, runtime: runtimeInfo.runtime, warning: runtimeInfo.warning, checks };
}

/** Startup self-check: the libkrun launcher and rootfs present. Returns problems found. */
export function checkSandbox(): string[] {
  const problems: string[] = [];
  if (!existsSync(config.sandbox.vmBin)) {
    problems.push(`libkrun launcher ${config.sandbox.vmBin} not found; build it with: npm run build:vm`);
  }
  if (!existsSync(config.sandbox.rootfs)) {
    problems.push(`libkrun rootfs ${config.sandbox.rootfs} not found; create it with: npm run build:rootfs`);
  }
  return problems;
}
