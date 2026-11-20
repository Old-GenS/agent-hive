// The web UI's safe Markdown subset (ui/src/markdown.ts). Node strips the types, so the module is
// imported directly; these cases pin the tags it may produce and the escaping it must keep.
import test from "node:test";
import assert from "node:assert/strict";

const { renderMarkdown } = await import("../ui/src/markdown.ts");

test("headings render one level down, so messages never outrank the page title", () => {
  assert.equal(renderMarkdown("# One"), "<h3>One</h3>");
  assert.equal(renderMarkdown("#### Four"), "<h6>Four</h6>");
});

test("unordered and ordered lists render one level", () => {
  assert.equal(renderMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(renderMarkdown("* a\n* b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(renderMarkdown("1. first\n2. second"), "<ol><li>first</li><li>second</li></ol>");
});

test("GitHub-style tables get a thead and tbody", () => {
  const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(
    html,
    "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("a fenced code block is literal: no inline markup, raw HTML stays escaped", () => {
  const html = renderMarkdown("```js\n**not bold** <b>\n```");
  assert.equal(html, "<pre><code>**not bold** &lt;b&gt;</code></pre>");
  assert.ok(!html.includes("<strong>"));
  assert.ok(!html.includes("<b>"));
});

test("inline code, bold and italic render", () => {
  const html = renderMarkdown("`code` **bold** *italic* _also italic_");
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>italic</em>"));
  assert.ok(html.includes("<em>also italic</em>"));
});

test("https links open in a new tab with rel=noopener noreferrer", () => {
  const html = renderMarkdown("[docs](https://example.com/a?b=1&c=2)");
  assert.ok(html.includes('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a>'));
});

test("a non-http(s) link stays plain text and never becomes an attribute", () => {
  const html = renderMarkdown("[x](javascript:alert(1))");
  assert.ok(!html.includes("<a "));
  assert.ok(!/href\s*=\s*"javascript:/i.test(html));
  assert.ok(html.includes("javascript:alert(1)"));
});

test("raw HTML in the input is escaped text, never markup", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("a quote in a link url cannot break out of the href attribute", () => {
  const html = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))');
  const href = html.match(/href="([^"]*)"/);
  assert.ok(href, "expected the link to render");
  assert.ok(!href[1].includes('"'));
  assert.ok(!html.includes('"onmouseover'));
  assert.ok(html.includes("&quot;onmouseover"));
});

test("blank lines separate paragraphs and single newlines become <br>", () => {
  assert.equal(renderMarkdown("one\ntwo\n\nthree"), "<p>one<br>two</p>\n<p>three</p>");
});
