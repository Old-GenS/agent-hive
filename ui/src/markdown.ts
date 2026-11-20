/**
 * A small, dependency-free Markdown renderer for the agent's timeline messages. It escapes the
 * whole input first, then builds a fixed set of tags from the escaped text, so raw HTML in the
 * input can never become markup (see the security model in AGENTS.md).
 *
 * Plain TypeScript with erasable syntax only (no enum, namespace or parameter properties), so the
 * browser bundle and `node --test` can both load it.
 */

/** The same escaping rules as esc() in util.ts; copied so this module stays self-contained. */
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const FENCE = /^ {0,3}```(\w*)\s*$/;
const FENCE_END = /^ {0,3}```\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const UL_ITEM = /^\s*[-*]\s+(.*)$/;
const OL_ITEM = /^\s*\d+\.\s+(.*)$/;
const SEP_CELL = /^:?-{3,}:?$/;

/**
 * Inline formatting: code spans, links, bold and italic. Code spans and http(s) links are held
 * aside as placeholders first, so bold/italic never rewrite text inside their tags or attributes.
 * Link text and urls are already escaped; a non-http(s) url matches nothing and stays plain text.
 */
function inline(text: string): string {
  const held: string[] = [];
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;
  let out = text.replace(/`([^`\n]+)`/g, (_match, code: string) => hold(`<code>${code}</code>`));
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) =>
      hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`),
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // Only _word_ with no letter or digit on either side, so snake_case_names stay as they are.
  out = out.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => held[Number(index)]);
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => SEP_CELL.test(cell));
}

/** Whether a line opens a block, so a paragraph ends before it even without a blank line. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  if (FENCE.test(line) || HEADING.test(line) || UL_ITEM.test(line) || OL_ITEM.test(line)) return true;
  return line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]);
}

/** Render a message's Markdown subset to safe HTML. Everything else stays escaped text. */
export function renderMarkdown(text: string): string {
  const lines = esc(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !FENCE_END.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      // One level down, so a message never outranks the page title.
      const level = Math.min(6, heading[1].length + 2);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const head = header.map((cell) => `<th>${inline(cell)}</th>`).join("");
      const body = rows
        .map((row) => `<tr>${header.map((_, j) => `<td>${inline(row[j] ?? "")}</td>`).join("")}</tr>`)
        .join("");
      blocks.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    const ordered = OL_ITEM.test(line);
    const itemPattern = ordered ? OL_ITEM : UL_ITEM;
    if (itemPattern.test(line)) {
      const items: string[] = [];
      while (i < lines.length && itemPattern.test(lines[i])) {
        items.push(`<li>${inline(lines[i].match(itemPattern)![1])}</li>`);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // A paragraph: consecutive lines up to a blank line or the start of another block.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, i))) {
      paragraph.push(inline(lines[i]));
      i++;
    }
    blocks.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return blocks.join("\n");
}
