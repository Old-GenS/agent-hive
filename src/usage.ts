/**
 * Live numbers for Settings > This computer: CPU use, memory, free disk space for runs and the
 * CPU temperature when the machine reports one. Linux paths sit under `sysRoot`, so tests can
 * point it at a fake tree; the disk is measured with statfs on the folder runs live in.
 */
import { mkdirSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

export interface Usage {
  cpu: { percent: number; cores: number; load1: number };
  memory: { usedBytes: number; totalBytes: number };
  disk: { path: string; freeBytes: number; totalBytes: number };
  temperature: { celsius: number; sensor: string } | null;
}

const TEMPERATURE_SENSORS = new Set(["coretemp", "k10temp", "zenpower", "cpu_thermal"]);

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function totalCpuMs(): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

/** Busy share of all cores over ~250 ms, 0-100 with one decimal. */
async function cpuPercent(): Promise<number> {
  const before = totalCpuMs();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = totalCpuMs();
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0) return 0;
  const busy = ((total - idle) / total) * 100;
  return Math.round(Math.min(100, Math.max(0, busy)) * 10) / 10;
}

function memoryInfo(sysRoot: string): { usedBytes: number; totalBytes: number } {
  const totalBytes = totalmem();
  const meminfo = readText(join(sysRoot, "proc/meminfo"));
  const match = meminfo ? /^\s*MemAvailable:\s*(\d+)\s*kB\s*$/m.exec(meminfo) : null;
  const available = match ? Number.parseInt(match[1], 10) * 1024 : freemem();
  return { usedBytes: totalBytes - available, totalBytes };
}

function diskInfo(diskPath: string): { path: string; freeBytes: number; totalBytes: number } {
  mkdirSync(diskPath, { recursive: true });
  const stats = statfsSync(diskPath);
  return {
    path: diskPath,
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
  };
}

function hwmonTemperature(sysRoot: string): { celsius: number; sensor: string } | null {
  const hwmonRoot = join(sysRoot, "sys/class/hwmon");
  let entries: string[];
  try {
    entries = readdirSync(hwmonRoot).sort();
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const name = readText(join(hwmonRoot, entry, "name"))?.trim();
    if (!name || !TEMPERATURE_SENSORS.has(name)) continue;
    const raw = readText(join(hwmonRoot, entry, "temp1_input"))?.trim();
    const millidegrees = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(millidegrees)) return { celsius: millidegrees / 1000, sensor: name };
  }
  return null;
}

function thermalZoneTemperature(sysRoot: string): { celsius: number; sensor: string } | null {
  const thermalRoot = join(sysRoot, "sys/class/thermal");
  let entries: string[];
  try {
    entries = readdirSync(thermalRoot).filter((entry) => entry.startsWith("thermal_zone")).sort();
  } catch {
    return null;
  }
  for (const entry of entries) {
    const type = readText(join(thermalRoot, entry, "type"))?.trim();
    if (type !== "x86_pkg_temp") continue;
    const raw = readText(join(thermalRoot, entry, "temp"))?.trim();
    const millidegrees = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(millidegrees)) return { celsius: millidegrees / 1000, sensor: type };
  }
  return null;
}

/** A snapshot of this computer right now. */
export async function usageNow(o: { sysRoot?: string; diskPath?: string } = {}): Promise<Usage> {
  const sysRoot = o.sysRoot ?? "/";
  const diskPath = o.diskPath ?? config.workspace;
  return {
    cpu: { percent: await cpuPercent(), cores: cpus().length, load1: loadavg()[0] },
    memory: memoryInfo(sysRoot),
    disk: diskInfo(diskPath),
    temperature: hwmonTemperature(sysRoot) ?? thermalZoneTemperature(sysRoot),
  };
}
