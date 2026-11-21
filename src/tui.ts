/**
 * Terminal output for the `hive` CLI: colour, a live status line, aligned tables, the agent's
 * Markdown rendered for a terminal, and the interactive pickers.
 *
 * Everything here is opt-in: callers decide whether a stream is interactive (see
 * `colorEnabled`) and plain output stays exactly as it was. No dependencies: the ANSI codes are
 * written directly so the module works in the bundled release as well.
 */
import * as readline from "node:readline";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const MAGENTA = "\u001b[35m";
const CYAN = "\u001b[36m";

/** The symbols the terminal views use. Plain (non-TTY) output never prints them. */
export const symbols = {
  done: "✓",
  failed: "✗",
  stopped: "■",
  tool: "▸",
  running: "●",
} as const;

export interface ColorStream {
  isTTY?: boolean;
}

/**
 * Whether to colour a stream: `NO_COLOR` wins over everything, then `FORCE_COLOR` (anything but
 * "0"), then the stream's own TTY flag.
 */
export function colorEnabled(stream: ColorStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return stream.isTTY === true;
}

function style(code: string, text: string, enabled: boolean): string {
  return enabled ? code + text + RESET : text;
}

export function bold(text: string, enabled = true): string {
  return style(BOLD, text, enabled);
}

export function dim(text: string, enabled = true): string {
  return style(DIM, text, enabled);
}

export function red(text: string, enabled = true): string {
  return style(RED, text, enabled);
}

export function green(text: string, enabled = true): string {
  return style(GREEN, text, enabled);
}

export function yellow(text: string, enabled = true): string {
  return style(YELLOW, text, enabled);
}

export function cyan(text: string, enabled = true): string {
  return style(CYAN, text, enabled);
}

export function magenta(text: string, enabled = true): string {
  return style(MAGENTA, text, enabled);
}

/** Remove ANSI escape sequences, so widths can be measured on visible text only. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Visible length of a possibly coloured string. */
function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** `4s`, `3m 12s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `$0.0123`. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/**
 * Align columns of text: each column padded to its widest visible cell, two spaces between
 * columns, the optional header row bold. Extra spaces after the last column are not emitted.
 */
export function table(rows: string[][], o: { header?: boolean; enabled?: boolean } = {}): string {
  const enabled = o.enabled ?? true;
  const header = o.header ?? false;
  if (rows.length === 0) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const widths: number[] = [];
  for (let c = 0; c < columns; c++) {
    widths[c] = Math.max(...rows.map((row) => visibleWidth(row[c] ?? "")));
  }
  return rows
    .map((row, r) => {
      const cells: string[] = [];
      for (let c = 0; c < columns; c++) {
        let cell = row[c] ?? "";
        if (c < columns - 1) {
          const pad = widths[c] - visibleWidth(cell);
          cell += " ".repeat(Math.max(0, pad));
        }
        if (r === 0 && header) cell = bold(cell, enabled);
        cells.push(cell);
      }
      return cells.join("  ");
    })
    .join("\n");
}

/** The part of a writable stream StatusLine needs. */
export interface StatusStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A one-line live status on stderr: `start`/`update` redraw it, `stop` clears it, and `print`
 * writes a permanent line without losing the status. The spinner only animates on a TTY; on a
 * non-TTY stream every method except `print` does nothing and `print` just writes the line.
 */
export class StatusLine {
  private readonly stream: StatusStream;
  private readonly tty: boolean;
  private text = "";
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private drawn = false;

  constructor(stream: StatusStream = process.stderr, o: { tty?: boolean } = {}) {
    this.stream = stream;
    this.tty = o.tty ?? stream.isTTY === true;
  }

  start(text: string): void {
    this.text = text;
    if (!this.tty) return;
    if (this.timer === undefined) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER.length;
        this.draw();
      }, 100);
      this.timer.unref?.();
    }
    this.draw();
  }

  update(text: string): void {
    this.text = text;
    if (this.tty && this.timer !== undefined) this.draw();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.tty) return;
    if (this.drawn) this.stream.write("\r\u001b[2K");
    this.drawn = false;
  }

  print(line: string): void {
    this.printOn(this.stream, line);
  }

  /**
   * Write a permanent line to `target` (stdout or stderr; on a terminal both show on the same
   * screen): clear the status line first so the text doesn't land on it, then redraw the status
   * below, but only while the status line is running (never after stop()).
   */
  printOn(target: { write(chunk: string): unknown }, line: string): void {
    if (!this.tty) {
      target.write(line + "\n");
      return;
    }
    if (this.drawn) this.stream.write("\r\u001b[2K");
    this.drawn = false;
    target.write(line + "\n");
    if (this.timer !== undefined) this.draw();
  }

  private draw(): void {
    const width = this.stream.columns ?? 80;
    const max = Math.max(1, width - 2);
    let text = this.text.replace(/\s*\n\s*/g, " ");
    if (text.length > max) text = text.slice(0, Math.max(0, max - 1)) + "…";
    this.stream.write("\r\u001b[2K" + SPINNER[this.frame] + " " + text);
    this.drawn = true;
  }
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const CODE = /`([^`]+)`/g;
const STRONG = /\*\*(.+?)\*\*/g;

function inlineMarkdown(text: string, enabled: boolean): string {
  if (!enabled) return text;
  let out = text.replace(LINK, (_match, label: string, url: string) => `${label} (${url})`);
  out = out.replace(CODE, (_match, code: string) => cyan(code, enabled));
  out = out.replace(STRONG, (_match, strong: string) => bold(strong, enabled));
  return out;
}

/**
 * Render Markdown for a terminal: bold headings (cyan for `#`/`##`), `**bold**`, cyan inline
 * code, dim indented fenced code blocks, `•` bullets, links as `text (url)` and numbered lists
 * and tables left as text. With `enabled` false the input is returned unchanged.
 */
export function renderMarkdownTerminal(text: string, enabled: boolean): string {
  if (!enabled) return text;
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      out.push(dim("  " + line, true));
      continue;
    }
    if (fenced) {
      out.push(dim("  " + line, true));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const body = inlineMarkdown(heading[2], enabled);
      out.push(bold(heading[1].length <= 2 ? cyan(body, enabled) : body, enabled));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      out.push(inlineMarkdown(line.replace(/^([-*])\s+/, "  • "), enabled));
      continue;
    }
    out.push(inlineMarkdown(line, enabled));
  }
  return out.join("\n");
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

type Key = { name?: string; sequence?: string; ctrl?: boolean };

/** The input surface the pickers need; a real TTY ReadStream has all of it. */
interface PickerInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * An arrow-key picker: ↑/↓ (or k/j) to move, Enter to choose, Ctrl+C or Esc to cancel (rejects
 * with `cancelled`). The list is drawn on `output`; raw mode is restored afterwards, including on
 * error. A non-TTY `input` rejects with `not a terminal`.
 */
export async function select<T>(
  question: string,
  choices: Choice<T>[],
  o: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {},
): Promise<T> {
  const input = (o.input ?? process.stdin) as unknown as PickerInput;
  const output = (o.output ?? process.stdout) as unknown as StatusStream & { write(chunk: string): unknown };
  if (input.isTTY !== true) throw new Error("not a terminal");
  if (choices.length === 0) throw new Error("no choices");

  readline.emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
  const wasRaw = input.isRaw === true;
  const color = colorEnabled(output);
  let index = 0;
  let drawn = 0;
  input.setRawMode?.(true);
  input.resume?.();

  const draw = (): void => {
    if (drawn > 0) output.write(`\u001b[${drawn}A`);
    for (let i = 0; i < choices.length; i++) {
      const selected = i === index;
      const marker = selected ? cyan("❯", color) : " ";
      const label = selected ? bold(choices[i].label, color) : choices[i].label;
      const hint = choices[i].hint === undefined ? "" : "  " + dim(choices[i].hint as string, color);
      output.write(`\r\u001b[2K${marker} ${label}${hint}\n`);
    }
    drawn = choices.length;
  };

  output.write(question + "\n");
  draw();

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      input.removeListener("keypress", onKey);
      input.setRawMode?.(wasRaw);
    };
    const onKey = (text: string | undefined, key: Key | undefined): void => {
      const name =
        key?.name ?? (text === "\r" || text === "\n" ? "return" : text === "\u0003" ? "c" : undefined);
      if ((name === "c" && key?.ctrl) || name === "escape") {
        cleanup();
        reject(new Error("cancelled"));
        return;
      }
      if (name === "up" || name === "k") {
        index = (index - 1 + choices.length) % choices.length;
        draw();
        return;
      }
      if (name === "down" || name === "j") {
        index = (index + 1) % choices.length;
        draw();
        return;
      }
      if (name === "return" || name === "enter") {
        cleanup();
        resolve(choices[index].value);
      }
    };
    input.on("keypress", onKey);
  });
}

/** One line of text, read with readline. A non-TTY `input` rejects with `not a terminal`. */
export async function ask(
  question: string,
  o: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {},
): Promise<string> {
  const input = o.input ?? process.stdin;
  const output = o.output ?? process.stdout;
  if (input.isTTY !== true) throw new Error("not a terminal");
  const rl = readline.createInterface({ input, output, terminal: output.isTTY === true });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}
