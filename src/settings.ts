/**
 * The run settings the web UI can change: VM CPUs and memory, runs at once, the time limit, the
 * stall time, the disk limit per run and how long finished runs are kept.
 *
 * They are read from the shell environment (wins, shown read-only), else the keys file, else the
 * defaults below. Saving writes the same private keys file the CLI reads at startup
 * (`~/.config/agent-hive/env`) and updates `config` in place, so new runs use the new values
 * without a server restart. The web UI's Settings > Runs page is the only writer.
 */
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import dotenv from "dotenv";
import { config, shellEnv } from "./config.js";
import { readKeysFile, setKeysFileValue } from "./keys.js";
import { parseMemoryMiB } from "./sandbox.js";
import { setMaxConcurrent } from "./web-runs.js";

export type SettingKey =
  | "cpus"
  | "memoryMiB"
  | "maxConcurrent"
  | "timeoutMin"
  | "stallMin"
  | "diskMaxGb"
  | "retentionDays";

/** Where a value comes from, in precedence order: this computer's environment, saved file, default. */
export type SettingSource = "default" | "file" | "dotenv" | "env";

export interface HostInfo {
  cpus: number;
  memoryMiB: number;
}

export interface SettingValue {
  value: number;
  default: number;
  min: number;
  max: number;
  source: SettingSource;
  /** The environment variable that sets this value (also the name saved in the keys file). */
  env: string;
}

export type SettingsMap = Record<SettingKey, SettingValue>;

interface SettingDef {
  env: string;
  label: string;
  /** Appended to limits in error messages, e.g. " MiB" or " minutes". */
  unit: string;
  default: number;
  min: number;
  max: (host: HostInfo) => number;
  /** Why the maximum is what it is, for the message ("at most 8 (this computer's CPUs)"). */
  why?: string;
  /** The effective value from config. */
  current: () => number;
  /** Put a value into config (and anything else that caches it). */
  apply: (value: number) => void;
}

function currentMemoryMiB(): number {
  try {
    return parseMemoryMiB(config.sandbox.memory);
  } catch {
    return 2048;
  }
}

function currentCpus(): number {
  const n = Number.parseInt(config.sandbox.cpus, 10);
  return Number.isFinite(n) ? n : 1;
}

const SETTINGS: Record<SettingKey, SettingDef> = {
  cpus: {
    env: "HIVE_SANDBOX_CPUS",
    label: "CPUs per run",
    unit: "",
    default: 1,
    min: 1,
    max: (host) => host.cpus,
    why: "this computer's CPUs",
    current: currentCpus,
    apply: (value) => {
      config.sandbox.cpus = String(value);
    },
  },
  memoryMiB: {
    env: "HIVE_SANDBOX_MEMORY",
    label: "Memory per run",
    unit: " MiB",
    default: 2048,
    min: 512,
    max: (host) => host.memoryMiB - 1024,
    why: "this computer's memory",
    current: currentMemoryMiB,
    apply: (value) => {
      config.sandbox.memory = `${value}m`;
    },
  },
  maxConcurrent: {
    env: "MAX_CONCURRENT_SESSIONS",
    label: "Runs at once",
    unit: "",
    default: 2,
    min: 1,
    max: () => 16,
    current: () => config.maxConcurrent,
    apply: (value) => {
      setMaxConcurrent(value);
    },
  },
  timeoutMin: {
    env: "HIVE_SANDBOX_TIMEOUT_MIN",
    label: "Time limit",
    unit: " minutes",
    default: 60,
    min: 5,
    max: () => 1440,
    current: () => config.sandbox.timeoutMin,
    apply: (value) => {
      config.sandbox.timeoutMin = value;
    },
  },
  stallMin: {
    env: "HIVE_STALL_MIN",
    label: "Stall time",
    unit: " minutes",
    default: 15,
    min: 0,
    max: () => 240,
    current: () => config.sandbox.stallMin,
    apply: (value) => {
      config.sandbox.stallMin = value;
    },
  },
  diskMaxGb: {
    env: "HIVE_RUN_DISK_MAX_GB",
    label: "Disk per run",
    unit: " GB",
    default: 20,
    min: 0,
    max: () => 1000,
    current: () => config.sandbox.diskMaxGb,
    apply: (value) => {
      config.sandbox.diskMaxGb = value;
    },
  },
  retentionDays: {
    env: "HIVE_RUN_RETENTION_DAYS",
    label: "Keep finished runs",
    unit: " days",
    default: 14,
    min: 0,
    max: () => 3650,
    current: () => config.runRetentionDays,
    apply: (value) => {
      config.runRetentionDays = value;
    },
  },
};

export const SETTING_KEYS: readonly SettingKey[] = [
  "cpus",
  "memoryMiB",
  "maxConcurrent",
  "timeoutMin",
  "stallMin",
  "diskMaxGb",
  "retentionDays",
];

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

/** This computer's parallelism and total RAM, the limits the settings are checked against. */
export function host(): HostInfo {
  return {
    cpus: availableParallelism(),
    memoryMiB: Math.floor(totalmem() / 2 ** 20),
  };
}

/** GiB for a MiB amount, one decimal at most ("16 GiB", "15.5 GiB"). */
function gib(mib: number): string {
  const g = mib / 1024;
  return `${Number.isInteger(g) ? g : g.toFixed(1)} GiB`;
}

/**
 * The `.env` file the server loaded at start (HIVE_DOTENV_PATH, else `.env` in the folder it was
 * started from), parsed again: its values sit under the keys file, so Reset falls back to them.
 */
function dotenvValues(): Record<string, string> {
  try {
    return dotenv.parse(readFileSync(process.env.HIVE_DOTENV_PATH || ".env"));
  } catch {
    return {};
  }
}

/** Every editable setting with its effective value, limits and where that value comes from. */
export function readSettings(): SettingsMap {
  const fileValues = readKeysFile();
  const dotenvFile = dotenvValues();
  const h = host();
  const out = {} as SettingsMap;
  for (const key of SETTING_KEYS) {
    const def = SETTINGS[key];
    const source: SettingSource = shellEnv[def.env]
      ? "env"
      : fileValues[def.env]
        ? "file"
        : dotenvFile[def.env]
          ? "dotenv"
          : "default";
    out[key] = {
      value: def.current(),
      default: def.default,
      min: def.min,
      max: def.max(h),
      source,
      env: def.env,
    };
  }
  return out;
}

export interface SettingsOk {
  ok: true;
  /** The patched values only, ready for applySettings. */
  values: Partial<Record<SettingKey, number>>;
  warnings: string[];
}

export interface SettingsFail {
  ok: false;
  errors: Record<string, string>;
  warnings: string[];
}

/**
 * Check a patch of settings against this computer. Per-key checks use each setting's min/max;
 * then, with the patched-or-current values, runs × memory must fit in RAM (an error) and
 * runs × CPUs may exceed the CPU count (a warning: VMs share CPUs).
 */
export function validateSettings(patch: Record<string, unknown>, hostInfo: HostInfo = host()): SettingsOk | SettingsFail {
  const errors: Record<string, string> = {};
  const values: Partial<Record<SettingKey, number>> = {};

  for (const [key, raw] of Object.entries(patch)) {
    if (!isSettingKey(key)) {
      errors[key] = "Unknown setting";
      continue;
    }
    const def = SETTINGS[key];
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      errors[key] = `${def.label} must be a whole number`;
      continue;
    }
    const max = def.max(hostInfo);
    if (raw < def.min) {
      errors[key] = `${def.label} must be at least ${def.min}${def.unit}`;
      continue;
    }
    if (raw > max) {
      const why = def.why ? ` (${def.why})` : "";
      errors[key] = `${def.label} must be at most ${max}${def.unit}${why}`;
      continue;
    }
    values[key] = raw;
  }

  const current = readSettings();
  const combined = (key: SettingKey): number => (values[key] !== undefined ? values[key] : current[key].value);
  const runs = combined("maxConcurrent");
  const memoryMiB = combined("memoryMiB");
  const cpus = combined("cpus");

  const warnings: string[] = [];
  if (cpus * runs > hostInfo.cpus) {
    warnings.push(
      `${runs} runs × ${cpus} CPUs is more than this computer's ${hostInfo.cpus} CPUs; VMs share CPUs, so runs will be slower`,
    );
  }

  const neededMiB = memoryMiB * runs;
  if (neededMiB > hostInfo.memoryMiB - 1024 && errors.maxConcurrent === undefined) {
    errors.maxConcurrent = `${runs} runs × ${memoryMiB} MiB needs ${gib(neededMiB)}; this computer has ${gib(hostInfo.memoryMiB)}`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, warnings };
  return { ok: true, values, warnings };
}

/**
 * Save values to the keys file and use them right away for new runs. Refuses a key that this
 * computer's environment sets, because that value wins over the file.
 */
export function applySettings(values: Partial<Record<SettingKey, number>>): void {
  const current = readSettings();
  const entries = SETTING_KEYS.filter((key) => values[key] !== undefined);
  for (const key of entries) {
    const def = SETTINGS[key];
    if (current[key].source === "env") {
      throw new Error(`${def.env} is set in the server's environment; change it there`);
    }
  }
  for (const key of entries) {
    const def = SETTINGS[key];
    const value = values[key]!;
    const stored = key === "memoryMiB" ? `${value}m` : String(value);
    setKeysFileValue(def.env, stored);
    process.env[def.env] = stored;
    def.apply(value);
  }
}

/** Remove a setting from the keys file and go back to its .env value or default. Refuses an environment value. */
export function resetSetting(key: string): void {
  if (!isSettingKey(key)) throw new Error(`Unknown setting "${key}"`);
  const def = SETTINGS[key];
  if (readSettings()[key].source === "env") {
    throw new Error(`${def.env} is set in the server's environment; change it there`);
  }
  setKeysFileValue(def.env, null);
  // Back to what the server started with under the keys file: its .env value, else the default.
  const fromDotenv = dotenvValues()[def.env];
  const parsed = fromDotenv === undefined ? NaN : key === "memoryMiB" ? parseMemoryMiB(fromDotenv) : Number.parseInt(fromDotenv, 10);
  if (Number.isFinite(parsed)) {
    process.env[def.env] = fromDotenv as string;
    def.apply(parsed);
  } else {
    delete process.env[def.env];
    def.apply(def.default);
  }
}

/** The message for a setting this computer's environment sets, for the API's 409. */
export function environmentMessage(key: SettingKey): string {
  return `${SETTINGS[key].env} is set in the server's environment; change it there`;
}
