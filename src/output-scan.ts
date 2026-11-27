/**
 * A checkpoint between the sandbox and the host's push: read the exported patches and report what
 * a person should look at before the commits leave this computer. A known host API key blocks a
 * push; secret-looking strings and changes that can run code outside the sandbox (CI workflows,
 * install scripts, submodules, executable files) are warnings.
 *
 * The scan only reads patch files; it never writes, executes or connects to anything. Secret
 * values never appear in a Finding: details carry a masked form only.
 */
import { basename } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { PROVIDERS, providerKey, setting } from "./config.js";

export type Finding = {
  level: "block" | "warn";
  kind: "known-key" | "secret-pattern" | "ci-workflow" | "install-script" | "submodule" | "executable" | "suspicious-code";
  file: string;
  detail: string;
};

export interface ScanResult {
  findings: Finding[];
  blocked: boolean;
  warned: boolean;
}

/** The largest patch file the scan reads; a bigger one is reported, not read. */
const MAX_PATCH_BYTES = 50 * 1024 * 1024;

/** A secret shorter than this is too likely to appear by accident to be a useful block. */
const MIN_KNOWN_SECRET = 12;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{60,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{32,}/g,
  /xox[abp]-[A-Za-z0-9-]{10,}/g,
];

/**
 * Code that is often how a hidden payload or a data grab looks: downloading and running a script,
 * a long encoded blob, reading credential files. Patterns only (no model reads the code, so a
 * prompt in the diff cannot argue its way past them); warnings, since each has honest uses.
 */
const SUSPICIOUS_CODE: { re: RegExp; detail: string }[] = [
  { re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, detail: "downloads and runs a script" },
  { re: /[A-Za-z0-9+/]{400,}={0,2}/, detail: "long base64-like blob" },
  { re: /(?:0x)?[0-9a-fA-F]{400,}/, detail: "long hex blob" },
  { re: /(~|\$HOME|\$\{HOME\}|homedir\(\))[^\n]{0,40}[/\\.](ssh|aws|gnupg|docker\/config\.json|netrc|git-credentials)\b/, detail: "reads a credentials location" },
  { re: /[\/'"`](\.ssh\/(id_[a-z0-9]+|authorized_keys)|\.aws\/credentials|\.netrc|\.git-credentials)\b/, detail: "reads a credentials file" },
];

/** Files where a long blob is expected (lockfiles, source maps, data), so it is not a finding. */
const BLOB_OK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock)$|\.(map|svg|json|lock|csv|txt|md|pem|crt)$/;

const CI_WORKFLOW = [/^\.github\/workflows\//, /^\.gitlab-ci\.yml$/, /^\.circleci\//, /^Jenkinsfile$/, /^azure-pipelines\.yml$/, /^\.buildkite\//];

const INSTALL_KEYS = [/^"preinstall"\s*:/, /^"install"\s*:/, /^"postinstall"\s*:/, /^"prepare"\s*:/];

/** A value safe to keep and show: first four characters, an ellipsis and the length. */
export function maskFinding(value: string): string {
  return `${value.slice(0, 4)}\u2026 (${value.length} chars)`;
}

/** The `b/` path of a `diff --git a/<p> b/<p>` line; undefined when this is not one. */
function diffPath(line: string): string | undefined {
  if (!line.startsWith("diff --git ")) return undefined;
  const rest = line.slice("diff --git ".length);
  // git quotes paths that need it; unquote the simple escaped forms before looking for " b/".
  const marker = " b/";
  const at = rest.lastIndexOf(marker);
  if (at <= 0) return undefined;
  let path = rest.slice(at + marker.length);
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  return path;
}

function fileBase(path: string): string {
  return basename(path);
}

/** True when `line` (an added line) adds an install hook to a package.json. */
function installScriptKey(line: string): string | undefined {
  const text = line.slice(1).trim();
  for (const re of INSTALL_KEYS) {
    const m = re.exec(text);
    if (m) return m[0].replace(/^"|"\s*:$/g, "").replace(/"/g, "");
  }
  return undefined;
}

function isCiWorkflow(path: string): boolean {
  return CI_WORKFLOW.some((re) => re.test(path));
}

/**
 * Scan one `git format-patch` text. Only added lines are read: a `+` line that is not the `+++`
 * header. `secrets` are exact host values; a match blocks. The same text may hold several patches.
 */
export function scanPatchText(text: string, secrets: string[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const known = secrets.filter((secret) => secret.length >= MIN_KNOWN_SECRET);
  const add = (level: Finding["level"], kind: Finding["kind"], file: string, detail: string): void => {
    const key = `${kind}\u0000${file}\u0000${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ level, kind, file, detail });
  };

  let file = "";
  let oldMode: string | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    const path = diffPath(line);
    if (path !== undefined) {
      file = path;
      oldMode = undefined;
      if (isCiWorkflow(path)) add("warn", "ci-workflow", path, "CI workflow changed");
      if (fileBase(path) === ".gitmodules") add("warn", "submodule", path, "submodule change");
      continue;
    }

    if (file === "") continue;

    if (line.startsWith("old mode ")) {
      oldMode = line.slice("old mode ".length).trim();
      continue;
    }
    if (line.startsWith("new file mode 100755")) {
      add("warn", "executable", file, "new executable file");
      continue;
    }
    if (line.startsWith("new mode ")) {
      const newMode = line.slice("new mode ".length).trim();
      if (oldMode === "100644" && newMode === "100755") add("warn", "executable", file, "file made executable");
      oldMode = undefined;
      continue;
    }

    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    // A known key on a line is the strong finding. A weaker pattern is skipped only when it is
    // the same secret, so a second, different token on that line is still reported.
    const knownHere: string[] = [];
    for (const secret of known) {
      if (!line.includes(secret)) continue;
      knownHere.push(secret);
      add("block", "known-key", file, maskFinding(secret));
    }

    for (const re of SECRET_PATTERNS) {
      re.lastIndex = 0;
      for (const match of line.matchAll(re)) {
        if (knownHere.some((secret) => secret.includes(match[0]) || match[0].includes(secret))) continue;
        add("warn", "secret-pattern", file, maskFinding(match[0]));
      }
    }

    // A long hex string is also valid base64: report it once, as hex.
    const hexBlob = /(?:0x)?[0-9a-fA-F]{400,}/.test(line);
    for (const { re, detail } of SUSPICIOUS_CODE) {
      if (detail.endsWith("blob") && BLOB_OK.test(file)) continue;
      if (detail === "long base64-like blob" && hexBlob) continue;
      if (re.test(line)) add("warn", "suspicious-code", file, detail);
    }

    if (fileBase(file) === "package.json") {
      const key = installScriptKey(line);
      if (key !== undefined) add("warn", "install-script", file, `adds a "${key}" script`);
    }
  }

  return findings;
}

function result(findings: Finding[]): ScanResult {
  return {
    findings,
    blocked: findings.some((f) => f.level === "block"),
    warned: findings.some((f) => f.level === "warn"),
  };
}

/**
 * Scan a run's exported patches. Each path is size-capped; a larger one becomes a warning rather
 * than being read. Findings are combined and de-duplicated by (kind, file, detail).
 */
export function scanPatches(paths: string[], secrets: string[]): ScanResult {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (finding: Finding): void => {
    const key = `${finding.kind}\u0000${finding.file}\u0000${finding.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const path of paths) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (size > MAX_PATCH_BYTES) {
      add({ level: "warn", kind: "secret-pattern", file: basename(path), detail: "patch too large to scan" });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const finding of scanPatchText(text, secrets)) add(finding);
  }
  return result(findings);
}

function tokensFromSetting(name: string): string[] {
  const raw = setting(name);
  if (!raw) return [];
  if (name === "API_TOKENS") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.keys(parsed as Record<string, unknown>);
      }
    } catch {
      // A malformed API_TOKENS is auth.ts's error to report; the scan just sees no tokens.
    }
    return [];
  }
  return [raw];
}

/**
 * The host's own secret values: every provider key hive knows (environment, keys file, .env) and
 * the API tokens if set, de-duplicated. There is deliberately no way to get these back out of a
 * Finding or meta.json.
 */
export function knownSecrets(): string[] {
  const secrets = new Set<string>();
  for (const provider of Object.keys(PROVIDERS)) {
    const value = providerKey(provider);
    if (value) secrets.add(value);
  }
  for (const value of tokensFromSetting("API_TOKEN")) if (value) secrets.add(value);
  for (const value of tokensFromSetting("API_TOKENS")) if (value) secrets.add(value);
  return [...secrets];
}
