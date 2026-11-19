/**
 * Plain-text rendering of pi's JSONL events for the `hive` CLI. No ANSI colours.
 */
export function renderEvent(e: any): string | undefined {
  if (e?.type === "message_end" && e.message?.role === "assistant") {
    if (e.message.errorMessage) return "error: " + e.message.errorMessage;
    const text = (Array.isArray(e.message.content) ? e.message.content : [])
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    return text || undefined;
  }
  if (e?.type === "tool_execution_start") {
    const args = e.args ?? {};
    let summary =
      e.toolName === "bash"
        ? args.command
        : e.toolName === "read" || e.toolName === "edit" || e.toolName === "write"
          ? args.path
          : JSON.stringify(args);
    summary = String(summary ?? "").replace(/\s+/g, " ").trim();
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
