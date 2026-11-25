/**
 * Plain-text rendering of pi's JSONL events for the `hive` CLI. No ANSI colours.
 */
import { dim, plainText, red, renderMarkdownTerminal, symbols } from "./tui.js";

export function renderEvent(e: any): string | undefined {
  if (e?.type === "message_end" && e.message?.role === "assistant") {
    if (e.message.errorMessage) return "error: " + plainText(String(e.message.errorMessage));
    const text = (Array.isArray(e.message.content) ? e.message.content : [])
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    return plainText(text) || undefined;
  }
  if (e?.type === "tool_execution_start") {
    const args = e.args ?? {};
    let summary =
      e.toolName === "bash"
        ? args.command
        : e.toolName === "read" || e.toolName === "edit" || e.toolName === "write"
          ? args.path
          : JSON.stringify(args);
    summary = plainText(String(summary ?? "")).replace(/\s+/g, " ").trim();
    if (summary.length > 100) summary = summary.slice(0, 99) + "…";
    return "  → " + e.toolName + " " + summary;
  }
  if (e?.type === "tool_execution_end" && e.isError === true) {
    return "  ✗ " + e.toolName + " failed";
  }
  return undefined;
}

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(total: Usage, e: any): void {
  if (e?.type !== "message_end" || e.message?.role !== "assistant") return;
  const u = e.message.usage ?? {};
  total.input += u.input ?? 0;
  total.output += u.output ?? 0;
  total.cacheRead += u.cacheRead ?? 0;
  total.cacheWrite += u.cacheWrite ?? 0;
  total.cost += u.cost?.total ?? 0;
}

/** The tool call's argument summary: the same text renderEvent uses, first line only. */
function toolSummary(e: any): string {
  const args = e.args ?? {};
  const summary =
    e.toolName === "bash"
      ? args.command
      : e.toolName === "read" || e.toolName === "edit" || e.toolName === "write"
        ? args.path
        : JSON.stringify(args);
  return plainText(String(summary ?? "")).replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * A pi event for a terminal: Markdown-rendered assistant text, a dimmed tool-call line and a red
 * failed-tool line. Falls back to renderEvent when colour is disabled, so plain output is
 * byte-for-byte what it was.
 */
export function renderEventStyled(e: any, o: { enabled: boolean; width?: number }): string | undefined {
  if (!o.enabled) return renderEvent(e);
  if (e?.type === "message_end" && e.message?.role === "assistant") {
    if (e.message.errorMessage) return red("error: " + plainText(String(e.message.errorMessage)), true);
    const text = (Array.isArray(e.message.content) ? e.message.content : [])
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    // Sanitise before the Markdown pass: hive adds its own escapes there, and those must survive.
    const safe = plainText(text);
    return safe ? renderMarkdownTerminal(safe, true) : undefined;
  }
  if (e?.type === "hive_note") {
    const text = plainText(String(e.text ?? ""));
    return text ? dim(text, true) : undefined;
  }
  if (e?.type === "tool_execution_start") {
    const tool = String(e.toolName ?? "");
    const prefix = `  ${symbols.tool} ${tool}  `;
    const room = Math.max(10, (o.width ?? 80) - prefix.length);
    const summary = truncate(toolSummary(e), room);
    return `  ${symbols.tool} ${tool}  ${dim(summary, true)}`;
  }
  if (e?.type === "tool_execution_end" && e.isError === true) {
    return red(`  ${symbols.failed} ${String(e.toolName ?? "")}  failed`, true);
  }
  return undefined;
}
