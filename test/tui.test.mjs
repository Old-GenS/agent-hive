// The terminal view: colour gating, durations and costs, tables, Markdown, the live status line
// and the pickers. Every test uses fake streams or environments, so nothing touches a real TTY.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

const {
  StatusLine,
  ask,
  bold,
  colorEnabled,
  formatCost,
  formatDuration,
  green,
  renderMarkdownTerminal,
  select,
  stripAnsi,
  table,
} = await import("../dist/tui.js");

/** A writable stream that records what is written to it. */
function fakeStream(o = {}) {
  const writes = [];
  return {
    writes,
    isTTY: o.isTTY === true,
    columns: o.columns,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    text() {
      return writes.join("");
    },
  };
}

test("colorEnabled: TTY flag, FORCE_COLOR, and NO_COLOR winning over both", () => {
  assert.equal(colorEnabled({ isTTY: true }, {}), true);
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  assert.equal(colorEnabled({ isTTY: undefined }, {}), false);

  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "true" }), true);
  assert.equal(colorEnabled({ isTTY: true }, { FORCE_COLOR: "0" }), true, "0 only disables forcing");

  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "" }), false, "NO_COLOR set to anything wins");
  assert.equal(colorEnabled({ isTTY: false }, { NO_COLOR: "1", FORCE_COLOR: "1" }), false);
});

test("formatDuration renders seconds, minutes and hours", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(4_000), "4s");
  assert.equal(formatDuration(59_900), "59s");
  assert.equal(formatDuration(3 * 60_000 + 12_000), "3m 12s");
  assert.equal(formatDuration(60 * 60_000), "1h 00m");
  assert.equal(formatDuration((60 + 2) * 60_000), "1h 02m");
  assert.equal(formatDuration(-5), "0s");
});

test("formatCost prints four decimals", () => {
  assert.equal(formatCost(0.0123), "$0.0123");
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(1.5), "$1.5000");
});

test("table pads by visible width, so ANSI codes don't break the alignment", () => {
  const plain = table(
    [
      ["RUN", "STATUS"],
      ["a", "done"],
      ["long-name", "failed"],
    ],
    { header: true, enabled: false },
  );
  assert.equal(plain, "RUN        STATUS\na          done\nlong-name  failed");

  const coloured = table(
    [
      [bold("RUN", true), bold("STATUS", true)],
      ["a", green("done", true)],
      ["long-name", "failed"],
    ],
    { header: true, enabled: true },
  );
  assert.match(coloured, /\u001b\[/);
  assert.equal(stripAnsi(coloured), plain, "colour does not change the visible layout");

  // Enabled but no header: nothing is styled, the rows still line up.
  assert.equal(
    table(
      [
        ["a", "x"],
        ["bbb", "y"],
      ],
      { enabled: true },
    ),
    "a    x\nbbb  y",
  );
});

test("renderMarkdownTerminal is a no-op when disabled", () => {
  const text = "# Title\n\n- one\n\n**bold** and `code`\n\n[text](https://example.com)";
  assert.equal(renderMarkdownTerminal(text, false), text);
});

test("renderMarkdownTerminal styles headings and bullets", () => {
  const out = renderMarkdownTerminal("# Title\n\n- one\n- two\n\nplain **bold** and `code`\n\n[text](https://example.com)", true);
  assert.match(out, /\u001b\[1m.*Title/, "the heading is bold");
  assert.match(out, /\u001b\[36m/, "the heading is cyan");
  assert.match(out, /^ {2}• one$/m, "a dash bullet becomes a • bullet");
  assert.match(out, /\*\*bold\*\*|\u001b\[1mbold\u001b\[0m/);
  assert.doesNotMatch(out, /`code`/);
  assert.match(out, /text \(https:\/\/example\.com\)/);

  const fenced = renderMarkdownTerminal("```\nconst a = 1;\n```", true);
  assert.match(fenced, /\u001b\[2m {2}const a = 1;/m, "code blocks are dim and indented");
});

test("StatusLine on a non-TTY writes only what print gets", () => {
  const stream = fakeStream({ isTTY: false });
  const status = new StatusLine(stream);
  status.start("Cloning");
  status.update("Agent working");
  status.stop();
  assert.equal(stream.text(), "", "start, update and stop write nothing off a terminal");
  status.print("a line");
  assert.equal(stream.text(), "a line\n");
});

test("StatusLine truncates to the stream width", () => {
  const stream = fakeStream({ isTTY: true, columns: 20 });
  const status = new StatusLine(stream);
  status.start("Cloning a very long repository name that will not fit");
  status.stop();
  const visible = stripAnsi(stream.text()).replace(/\r/g, "");
  for (const line of visible.split(/\u001b\[2K/)) {
    assert.ok(line.length <= 20, `line fits in 20 columns: ${JSON.stringify(line)}`);
  }
});

test("select and ask reject a non-TTY input", async () => {
  await assert.rejects(
    () => select("Pick", [{ label: "a", value: "a" }], { input: { isTTY: false }, output: fakeStream() }),
    /not a terminal/,
  );
  await assert.rejects(() => ask("Name?", { input: { isTTY: false }, output: fakeStream() }), /not a terminal/);
});

test("select moves with the down arrow and returns the second choice, restoring raw mode", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const rawModes = [];
  input.setRawMode = (mode) => {
    rawModes.push(mode);
  };
  const output = fakeStream({ isTTY: true, columns: 80 });

  const choice = select("Pick one", [{ label: "first", value: 1 }, { label: "second", value: 2 }], {
    input,
    output,
  });
  input.write("\u001b[B");
  input.write("\r");

  assert.equal(await choice, 2);
  assert.deepEqual(rawModes, [true, false], "raw mode is restored after choosing");
  assert.match(output.text(), /Pick one/);
  assert.match(output.text(), /second/);
});

test("select rejects with cancelled on Ctrl+C and still restores raw mode", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const rawModes = [];
  input.setRawMode = (mode) => {
    rawModes.push(mode);
  };
  const choice = select("Pick one", [{ label: "a", value: "a" }], { input, output: fakeStream({ isTTY: true }) });
  input.write("\u0003");
  await assert.rejects(() => choice, /cancelled/);
  assert.deepEqual(rawModes, [true, false]);
});

test("shouldOpenBrowser: flags win, else only a terminal with a desktop and no SSH", async () => {
  const { shouldOpenBrowser } = await import("../dist/tui.js");
  const linux = { tty: true, platform: "linux", wsl: false };
  assert.equal(shouldOpenBrowser({}, { DISPLAY: ":0" }, linux), true);
  assert.equal(shouldOpenBrowser({}, { WAYLAND_DISPLAY: "wayland-0" }, linux), true);
  assert.equal(shouldOpenBrowser({}, {}, linux), false);
  assert.equal(shouldOpenBrowser({}, { DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" }, linux), false);
  assert.equal(shouldOpenBrowser({}, { DISPLAY: ":0" }, { ...linux, tty: false }), false);
  assert.equal(shouldOpenBrowser({}, {}, { ...linux, wsl: true }), true);
  assert.equal(shouldOpenBrowser({}, {}, { tty: true, platform: "darwin", wsl: false }), true);
  assert.equal(shouldOpenBrowser({ "no-open": true }, { DISPLAY: ":0" }, linux), false);
  assert.equal(shouldOpenBrowser({ open: true }, {}, { ...linux, tty: false }), true);
});
