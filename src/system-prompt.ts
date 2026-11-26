/**
 * The instructions hive gives the agent: the built-in default, an editable copy on disk (Settings
 * › Runs), and optional per-run instructions that add to or replace the default.
 *
 * The prompt file is host-only. It is never read from a run's VM-writable folders; startRun writes
 * the composed base prompt to the run's host-only system-base.md.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const BUILTIN_SYSTEM_PROMPT =
  "You are a senior software developer. Be direct and concise, show code, skip filler. Don't gold-plate, but don't leave it half-done. Check multiple locations and follow the project's conventions. Flag risks. If unsure, say so. Commit each finished piece of work as soon as it is done, before running long checks, installing tools or starting the next piece: the run has a time limit, and only committed work is kept. If a check needs a tool you can't get working within a few minutes, skip it, say so, and finish. Check web pages through the DOM, console output or tests where you can; take screenshots only when the look itself matters, and don't re-open old ones: every image stays in the conversation and slows each later request.";

export const MAX_SYSTEM_PROMPT = 20_000;

/** ~/.config/agent-hive/system-prompt.md, or under XDG_CONFIG_HOME when it is set. */
export function systemPromptPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-hive/system-prompt.md");
}

export type SystemPromptSource = "env" | "file" | "builtin";

/**
 * The default instructions for a new run: HIVE_SYSTEM_PROMPT wins, then a non-empty file, then
 * hive's built-in text. The file is read on every call, so an edit applies to the next run without
 * a restart.
 */
export function defaultSystemPrompt(): { text: string; source: SystemPromptSource } {
  const env = process.env.HIVE_SYSTEM_PROMPT;
  if (env !== undefined && env.trim() !== "") return { text: env, source: "env" };

  const path = systemPromptPath();
  try {
    const text = readFileSync(path, "utf8");
    if (text.trim() !== "") return { text, source: "file" };
  } catch {
    // Missing, unreadable or not a regular file: fall through to the built-in text.
  }
  return { text: BUILTIN_SYSTEM_PROMPT, source: "builtin" };
}

/** Save the editable default, atomically and readable only by the user. */
export function saveSystemPrompt(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("The instructions cannot be empty");
  if (trimmed.length > MAX_SYSTEM_PROMPT) {
    throw new Error(`The instructions are too long (${trimmed.length} characters; the maximum is ${MAX_SYSTEM_PROMPT})`);
  }
  const path = systemPromptPath();
  mkdirSync(dirname(path), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const tmp = `${path}.${suffix}.tmp`;
  try {
    writeFileSync(tmp, trimmed, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Delete the saved default; no error when there is no file. */
export function resetSystemPrompt(): void {
  rmSync(systemPromptPath(), { force: true });
}

/**
 * The base prompt plus a run's own instructions. With no instructions the base is used unchanged;
 * "add" appends them under a heading, "replace" uses only them.
 */
export function composeSystemPrompt(
  base: string,
  extra: string | undefined,
  mode: "add" | "replace" = "add",
): string {
  const trimmed = extra?.trim() ?? "";
  if (!trimmed) return base;
  if (trimmed.length > MAX_SYSTEM_PROMPT) {
    throw new Error(`The instructions for this run are too long (${trimmed.length} characters; the maximum is ${MAX_SYSTEM_PROMPT})`);
  }
  if (mode === "replace") return trimmed;
  return `${base}\n\nInstructions for this run:\n${trimmed}`;
}
