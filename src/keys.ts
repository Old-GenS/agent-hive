/**
 * Provider API keys kept in one private file (mode 600), plus the checks for them.
 *
 * This module deliberately does not import ./config.ts: config.ts imports it, and the lookup
 * order (transient environment > saved file > server .env / process environment) is decided by
 * the caller, which passes the environments in. Nothing here ever logs a key.
 */
import dotenv from "dotenv";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The private file both the CLI and the server read: `HIVE_KEYS_FILE`, else XDG config. */
export function keysFilePath(): string {
  return (
    process.env.HIVE_KEYS_FILE ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-hive/env")
  );
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const VALUE_RE = /^[\x21-\x7E]{1,400}$/;
const FORBIDDEN_IN_VALUE = /["'#\\`]/;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  values: Record<string, string>;
}

const readCache = new Map<string, CacheEntry>();

/**
 * Parse the keys file. Repeated calls are cheap: the file is only re-read when its mtime or size
 * changes, so edits made by another process (or the CLI while the server runs) are picked up.
 */
export function readKeysFile(path: string = keysFilePath()): Record<string, string> {
  const file = resolve(path);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return {};
  }
  const cached = readCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.values;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const values = dotenv.parse(text);
  readCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, values });
  return values;
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`Invalid key name "${name}": use A-Z, 0-9 and _`);
}

function checkValue(value: string): void {
  if (!VALUE_RE.test(value)) {
    throw new Error("Invalid key value: use 1-400 printable ASCII characters with no spaces or newlines");
  }
  if (FORBIDDEN_IN_VALUE.test(value)) {
    throw new Error("Invalid key value: quotes, #, \\ and ` are not allowed");
  }
}

/**
 * Set (or, with `null`, remove) one NAME=value line, keeping every other line and comment as it
 * was. The write is atomic: a temp file with mode 600 in the same folder is renamed over the
 * target, then the target is chmodded to 600 (in case it existed with wider permissions).
 */
export function setKeysFileValue(name: string, value: string | null, path: string = keysFilePath()): void {
  checkName(name);
  if (value !== null) checkValue(value);

  const file = resolve(path);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && match[1] === name) {
      if (value !== null && !replaced) {
        out.push(`${name}=${value}`);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (value !== null && !replaced) out.push(`${name}=${value}`);

  const next = out.length === 0 ? "" : out.join("\n") + "\n";
  const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  readCache.delete(file);
}

/** A masked key for display: never the whole key, and at least 4 characters stay hidden. */
export function maskKey(key: string): string {
  if (key.length >= 12) {
    const keep = Math.min(6, key.length - 8);
    return `${key.slice(0, keep)}\u2026${key.slice(-4)}`;
  }
  return `\u2026${key.slice(-2)}`;
}

export type KeySource = "environment" | "saved" | "env-file";

/**
 * The first of `names` that has a value, in the plan's precedence order: the environment the
 * process started with ("environment"), the keys file ("saved"), then the process environment
 * after .env loading ("env-file").
 */
export function keySource(
  names: string[],
  shellEnv: Readonly<Record<string, string | undefined>>,
  processEnv: Record<string, string | undefined>,
  fileValues: Record<string, string>,
): { value: string; source: KeySource; name: string } | undefined {
  for (const name of names) {
    const value = shellEnv[name];
    if (value) return { value, source: "environment", name };
  }
  for (const name of names) {
    const value = fileValues[name];
    if (value) return { value, source: "saved", name };
  }
  for (const name of names) {
    const value = processEnv[name];
    if (value) return { value, source: "env-file", name };
  }
  return undefined;
}

interface TestEndpoint {
  url: string;
  headers: (key: string) => Record<string, string>;
}

const TEST_ENDPOINTS: Record<string, TestEndpoint> = {
  deepseek: {
    url: "https://api.deepseek.com/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/key",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  zai: {
    url: "https://api.z.ai/api/coding/paas/v4/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

export interface KeyTestResult {
  status: "works" | "refused" | "unchecked";
  detail: string;
}

/**
 * One GET against the provider's models/key endpoint with a 10 s timeout. The detail never
 * contains the key. Unknown providers throw; a network error is "unchecked", not an exception.
 */
export async function testKey(
  provider: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyTestResult> {
  const endpoint = TEST_ENDPOINTS[provider];
  if (!endpoint) throw new Error(`Unknown provider "${provider}"`);
  try {
    const res = await fetchImpl(endpoint.url, {
      method: "GET",
      headers: endpoint.headers(key),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: "works", detail: "The provider accepted the key" };
    if (res.status === 401 || res.status === 403) {
      return { status: "refused", detail: `The provider refused the key (HTTP ${res.status})` };
    }
    return { status: "unchecked", detail: `Couldn't check the key (HTTP ${res.status})` };
  } catch {
    return { status: "unchecked", detail: "Couldn't reach the provider" };
  }
}
