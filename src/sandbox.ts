/**
 * Runs commands in a throwaway sandbox: a libkrun microVM launched directly by vm/hive-vm. On
 * Linux the launcher runs inside a pasta network namespace that forwards exactly the egress
 * proxy's port; on macOS there is no pasta, so the VM boots with its implicit TSI device disabled
 * and one vsock port mapped to a socket this process serves (src/vsock.ts). Either way the VM
 * reaches only hive's egress proxy, and the sandbox gets only the mounts and env vars passed in:
 * the host's SSH keys, gh login and .env never enter it.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { config } from "./config.js";
import { proxyEnv, sharedEgressProxy } from "./egress.js";
import { GUEST_PROXY_PORT, startVsockBridge, VSOCK_PORT, type VsockBridge } from "./vsock.js";
import { followJsonl } from "./follow.js";
import { fixFor, hostInfo } from "./fixes.js";
import { libkrunChoice, libkrunLabel } from "./libkrun.js";
import { pastaChoice, pastaLabel } from "./pasta.js";
import type { CheckId, Fix } from "./fixes.js";

export type Isolation = "microvm" | "unavailable";

export interface RuntimeInfo {
  runtime: "libkrun";
  isolation: Isolation;
  warning?: string;
}

/**
 * Hardware virtualization: /dev/kvm on Linux, Hypervisor.framework on macOS (Apple silicon only;
 * sysctl kern.hv_support is 1 there and 0 when the Mac cannot run a VM).
 */
export function hardwareVirtualization(): boolean {
  if (networkBackend() === "vsock") {
    const r = spawnSync("sysctl", ["-n", "kern.hv_support"], { encoding: "utf8", timeout: 5_000 });
    return r.status === 0 && r.stdout.trim() === "1";
  }
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * How a VM's only network path is built here: pasta on Linux, one mapped vsock port on macOS.
 * The platform is a parameter so tests can check both without running on both.
 */
export function networkBackend(platform: NodeJS.Platform = process.platform): "pasta" | "vsock" {
  return platform === "darwin" ? "vsock" : "pasta";
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

let pastaHelpText: string | undefined;

/**
 * Whether the installed pasta knows `option`. Distros ship pasta versions years apart (Ubuntu
 * 24.04's is from February 2024 and has no --dns-host), so optional flags are checked against
 * `pasta --help` once per process. The binary probed is the one hive will actually run.
 */
export function pastaSupports(option: string, help?: string): boolean {
  if (help === undefined) {
    if (pastaHelpText === undefined) {
      const r = spawnSync(pastaChoice().path, ["--help"], { encoding: "utf8", timeout: 5_000 });
      pastaHelpText = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    }
    help = pastaHelpText;
  }
  return new RegExp(`(^|\\s)${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|=|$)`, "m").test(help);
}

function resolvConf(): string {
  try {
    return readFileSync("/etc/resolv.conf", "utf8");
  } catch {
    return "";
  }
}

/**
 * True when the libkrun backend can run here: hardware virtualization, the launcher, the VM
 * filesystem and libkrun. Linux also needs pasta; macOS needs a root disk image instead of a
 * rootfs directory (docs/MACOS.md).
 */
export function libkrunAvailable(): boolean {
  try {
    if (!hardwareVirtualization()) return false;
    if (!existsSync(config.sandbox.vmBin)) return false;
    const rootfs = realpathSync(config.sandbox.rootfs);
    if (networkBackend() === "vsock") {
      if (!statSync(rootfs).isFile()) return false;
    } else {
      if (!existsSync(join(rootfs, "usr/local/bin/hive-vm-init"))) return false;
      if (!pastaChoice().ok) return false;
    }
    return libkrunChoice().ok;
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
      : networkBackend() === "vsock"
        ? "libkrun is not available: a microVM on macOS needs Hypervisor.framework, libkrun, the launcher and the VM image."
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

/**
 * The most folders one VM can share: libkrun runs out of interrupt slots (`IrqsExhausted`) above
 * this, and the VM then never boots. `runSandbox` adds the /io share itself, so callers may pass
 * at most MAX_SHARES - 1 mounts.
 */
export const MAX_SHARES = 5;

/** pasta + hive-vm argv; env values travel via the child's env, never here. */
export function buildLibkrunCommand(
  opts: SandboxOptions,
  p: {
    vmBin: string;
    rootfs: string;
    cpus: number;
    memoryMiB: number;
    /** host resolver for the VM's DNS; left out on pasta versions without --dns-host */
    hostDns?: string;
    timeoutSec: number;
    /** where the launcher sends its own stderr, including libkrun's log lines */
    stderrFile: string;
    /** the pasta binary to run; the bare name keeps the system PATH lookup for tests and callers */
    pastaBin?: string;
    /**
     * The port of hive's egress proxy, when the VM's only way out is that proxy. With it, pasta
     * runs without --config-net and forwards just this one port from the VM to the host's
     * loopback; the VM gets no DNS and no direct network.
     */
    proxyPort?: number;
  },
): { file: string; args: string[] } {
  const netArgs =
    p.proxyPort !== undefined
      ? ["-q", "-T", String(p.proxyPort), "-U", "none", "--no-map-gw"]
      : [
          "--config-net", "-q", "-T", "none", "-U", "none", "--no-map-gw",
          "--dns-forward", "169.254.1.53",
          // Older pasta has no --dns-host; it then forwards to the first nameserver in resolv.conf.
          ...(p.hostDns !== undefined ? ["--dns-host", p.hostDns] : []),
        ];
  const args = [
    ...netArgs,
    "--", "/usr/bin/env", p.vmBin,
    "--rootfs", p.rootfs, "--cpus", String(p.cpus), "--memory", String(p.memoryMiB),
    "--timeout", String(p.timeoutSec),
    "--stderr-file", p.stderrFile,
  ];
  for (const m of opts.mounts) args.push("--share", `${m.host}:${m.container}${m.ro ? ":ro" : ""}`);
  for (const name of Object.keys(opts.env)) args.push("--env", name);
  // With the proxy there is no DNS in the VM: names are resolved by the proxy, on the host.
  if (p.proxyPort === undefined) args.push("--dns", "169.254.1.53");
  args.push("--workdir", "/work", "--", ...opts.command);
  return { file: p.pastaBin ?? "pasta", args };
}

/**
 * The launcher argv for a macOS VM: no pasta, one vsock port mapped to the bridge socket, the VM
 * image attached read-only, and the pidfile and owner pid the launcher needs to clean up after a
 * crashed hive. Env values still travel via the child's env, never here.
 */
export interface DirectLaunch {
  vmBin: string;
  rootfs: string;
  cpus: number;
  memoryMiB: number;
  timeoutSec: number;
  /** where the launcher sends its own stderr, including libkrun's log lines */
  stderrFile: string;
  /** the short UNIX socket the launcher maps the guest's proxy port to */
  vsockSocket: string;
  /** the hive process the launcher stops the VM for when it dies */
  watchPid?: number;
  /** records the launcher's pid in the run folder for a later cleanup */
  pidFile?: string;
}

export function buildDirectCommand(opts: SandboxOptions, p: DirectLaunch): { file: string; args: string[] } {
  const args = [
    "--rootfs", p.rootfs,
    "--cpus", String(p.cpus),
    "--memory", String(p.memoryMiB),
    "--timeout", String(p.timeoutSec),
    "--stderr-file", p.stderrFile,
    "--vsock", `${VSOCK_PORT}:${p.vsockSocket}`,
  ];
  if (p.pidFile) args.push("--pidfile", p.pidFile);
  if (p.watchPid !== undefined) args.push("--watch-pid", String(p.watchPid));
  for (const m of opts.mounts) args.push("--share", `${m.host}:${m.container}${m.ro ? ":ro" : ""}`);
  for (const name of Object.keys(opts.env)) args.push("--env", name);
  args.push("--workdir", "/work", "--", ...opts.command);
  return { file: p.vmBin, args };
}

function spawnDirect(opts: SandboxOptions, bridge: VsockBridge) {
  const { sandbox } = config;
  const cmd = buildDirectCommand(opts, {
    vmBin: sandbox.vmBin,
    rootfs: realpathSync(sandbox.rootfs),
    cpus: Number.parseInt(sandbox.cpus, 10),
    memoryMiB: parseMemoryMiB(sandbox.memory),
    timeoutSec: sandbox.timeoutMin * 60,
    stderrFile: `${opts.ioDir}.launcher.log`,
    vsockSocket: bridge.socketPath,
    watchPid: process.pid,
    pidFile: `${opts.ioDir}.vm.pid`,
  });
  // The launcher reads HIVE_LIBKRUN from its own env.
  return spawn(cmd.file, cmd.args, {
    env: { ...process.env, ...opts.env, HIVE_LIBKRUN: libkrunChoice().path },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

function spawnLibkrun(opts: SandboxOptions, proxyPort?: number) {
  const { sandbox } = config;
  const cmd = buildLibkrunCommand(opts, {
    vmBin: sandbox.vmBin,
    rootfs: realpathSync(sandbox.rootfs),
    cpus: Number.parseInt(sandbox.cpus, 10),
    memoryMiB: parseMemoryMiB(sandbox.memory),
    hostDns: pastaSupports("--dns-host") ? hostNameserver(resolvConf()) : undefined,
    timeoutSec: sandbox.timeoutMin * 60,
    // A sibling of the io folder, never inside it: the VM can write io/, so it must not be able to
    // replace the log hive reads with a symlink.
    stderrFile: `${opts.ioDir}.launcher.log`,
    pastaBin: pastaChoice().path,
    proxyPort,
  });
  // The launcher reads HIVE_LIBKRUN from its own env.
  return spawn(cmd.file, cmd.args, {
    env: { ...process.env, ...opts.env, HIVE_LIBKRUN: libkrunChoice().path },
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

export async function runSandbox(opts: SandboxOptions): Promise<SandboxHandle> {
  const { sandbox } = config;
  const ioDir = opts.ioDir;
  if (opts.mounts.length + 1 > MAX_SHARES) {
    throw new Error(`too many shared folders for one VM: ${opts.mounts.length + 1} (libkrun supports ${MAX_SHARES})`);
  }
  // The proxy must be listening before pasta forwards its port or the bridge opens its socket, so
  // this has to happen before the VM is spawned: that is what makes runSandbox async.
  const vsock = networkBackend() === "vsock";
  let proxyPort: number | undefined;
  let env = opts.env;
  if (sandbox.network === "proxy") {
    const proxy = await sharedEgressProxy();
    proxyPort = proxy.port;
    // Names are passed to the launcher as --env NAME; values ride in the child's environment. On
    // macOS the guest's proxy is on its own loopback, relayed over vsock by hive-netd.
    env = { ...opts.env, ...(vsock ? proxyEnv(`http://127.0.0.1:${GUEST_PROXY_PORT}`) : proxy.env) };
  }
  if (vsock && proxyPort === undefined) {
    throw new Error("a macOS VM's only network path is hive's egress proxy (HIVE_NETWORK=direct is not supported)");
  }
  resetIoDir(ioDir);
  const launch: SandboxOptions = {
    ...opts,
    env,
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
  // The bridge listens before the launcher starts, so the guest's first connection is never
  // refused. It lives only as long as the VM.
  const bridge = vsock ? await startVsockBridge(proxyPort as number) : undefined;
  let child: ReturnType<typeof spawnLibkrun>;
  try {
    child = vsock ? spawnDirect(launch, bridge as VsockBridge) : spawnLibkrun(launch, proxyPort);
  } catch (err) {
    await bridge?.close();
    throw err;
  }

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
      void bridge?.close();
      resolve({ code: 127, stdout: stdoutTail, stderr: `${stderrTail}\n${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // stop() does a last poll, so events written just before exit still arrive.
      follower?.stop();
      void bridge?.close();
      // The launcher's own errors come first: when the VM never booted, they are the only clue.
      // Its log lives outside io/, so this is host-trusted text, then the VM's stderr.log.
      const parts = [
        readTail(`${ioDir}.launcher.log`, MAX_KEPT_OUTPUT),
        readTail(join(ioDir, "stderr.log"), MAX_KEPT_OUTPUT),
        stderrTail,
      ].filter((part) => part.length > 0);
      stderrTail = parts.join("\n").slice(-MAX_KEPT_OUTPUT);
      const timedOut = hitTimeout || code === 124 || (code !== 0 && Date.now() - started >= sandbox.timeoutMin * 60_000);
      resolve({ code: code ?? 1, stdout: stdoutTail, stderr: stderrTail, timedOut });
    });
  });

  const stop = async () => {
    if (child.exitCode === null) {
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
    }
    await bridge?.close();
  };

  return { done, stop };
}

/**
 * The last `max` bytes of a file the VM wrote, without following symlinks and only when it is a
 * regular file; "" if unreadable. O_NONBLOCK keeps a planted FIFO from hanging the open.
 */
function readTail(path: string, max: number): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return "";
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "";
    const size = stat.size;
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
  id: CheckId;
  ok: boolean;
  detail: string;
  /** The distro-aware fix, set only when the check fails. */
  fix?: Fix;
}

/** What the server runs sandboxes with, plus the checks behind it, for the UI's "This computer". */
export function systemInfo(): {
  isolation: RuntimeInfo["isolation"];
  runtime: string;
  warning?: string;
  checks: SystemCheck[];
} {
  const checks: SystemCheck[] = [];
  if (networkBackend() === "vsock") {
    const hvf = hardwareVirtualization();
    checks.push({
      name: "Hardware virtualization",
      id: "kvm",
      ok: hvf,
      detail: hvf ? "Hypervisor.framework (HVF)" : "Hypervisor.framework is not available (kern.hv_support is not 1)",
    });
  } else {
    let kvm = "ok";
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    } catch (err) {
      kvm = (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "no access";
    }
    checks.push({
      name: "Hardware virtualization",
      id: "kvm",
      ok: kvm === "ok",
      detail: kvm === "ok" ? "/dev/kvm" : `/dev/kvm: ${kvm}`,
    });
  }
  const launcher = existsSync(config.sandbox.vmBin);
  const libkrun = libkrunChoice();
  checks.push({
    name: "libkrun (starts the VM)",
    id: "libkrun",
    ok: libkrun.ok,
    detail: libkrun.ok ? `${libkrunLabel(libkrun)} (${libkrun.path})` : libkrun.path,
  });
  const networkText =
    config.sandbox.network === "proxy"
      ? "VMs reach the internet through hive's proxy, not this computer or the local network"
      : "VMs reach the internet and the local network, not this computer (HIVE_NETWORK=direct)";
  if (networkBackend() === "vsock") {
    checks.push({
      name: "vsock egress (network isolation)",
      id: "network",
      ok: true,
      detail:
        "one vsock port to hive's proxy: the VM has no IP network and no DNS, and reaches only the proxy (HIVE_NETWORK=proxy)",
    });
  } else {
    const pasta = pastaChoice();
    checks.push({
      name: "pasta (network isolation)",
      id: "pasta",
      ok: pasta.ok,
      detail: pasta.ok ? `${pastaLabel(pasta)} (${pasta.path}): ${networkText}` : networkText,
    });
  }
  checks.push({ name: "VM launcher", id: "launcher", ok: launcher, detail: config.sandbox.vmBin });
  let rootfs = config.sandbox.rootfs;
  let rootfsOk = false;
  try {
    rootfs = realpathSync(config.sandbox.rootfs);
    rootfsOk =
      networkBackend() === "vsock"
        ? statSync(rootfs).isFile()
        : existsSync(join(rootfs, "usr/local/bin/hive-vm-init"));
  } catch {
    rootfsOk = false;
  }
  checks.push({ name: "VM filesystem", id: "rootfs", ok: rootfsOk, detail: rootfs });
  const host = hostInfo();
  for (const check of checks) {
    if (!check.ok) check.fix = fixFor(check.id, host, check.detail);
  }
  return { isolation: runtimeInfo.isolation, runtime: runtimeInfo.runtime, warning: runtimeInfo.warning, checks };
}

/** Startup self-check: the libkrun launcher and rootfs present. Returns problems found. */
export function checkSandbox(): string[] {
  const problems: string[] = [];
  if (!existsSync(config.sandbox.vmBin)) {
    problems.push(`libkrun launcher ${config.sandbox.vmBin} not found; build it with: npm run build:vm`);
  }
  if (!existsSync(config.sandbox.rootfs)) {
    problems.push(
      networkBackend() === "vsock"
        ? `VM image ${config.sandbox.rootfs} not found; see docs/MACOS.md`
        : `libkrun rootfs ${config.sandbox.rootfs} not found; create it with: npm run build:rootfs`,
    );
  }
  return problems;
}
