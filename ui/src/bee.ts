/**
 * The bee activity indicator: a honeycomb cell with a bee that flies around it while a run is
 * busy, hovers while it is queued, lands when it is done and goes grey when it failed or was
 * stopped. Plus the small bee that sits next to Runs in the header while a run is busy.
 *
 * Everything is built with createElementNS/createElement — no markup parsing anywhere.
 */
import { el } from "./util.js";

export type BeeState = "queued" | "working" | "done" | "failed" | "stopped";

export interface BeeIndicator {
  root: HTMLElement;
  set(state: BeeState, label: string): void;
  destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Unique clip-path ids: two bees can be on the page at once (indicator and header). */
let clipSeq = 0;

function svgNode(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

/** Clip the body stripes to the body ellipse. */
function clipDefs(clipId: string): SVGElement {
  const defs = svgNode("defs", {});
  const clip = svgNode("clipPath", { id: clipId });
  clip.append(svgNode("ellipse", { cx: "0", cy: "0", rx: "7", ry: "5" }));
  defs.append(clip);
  return defs;
}

/**
 * The bee itself, centred on (0, 0): two wings, a honey body, two stripes and a head at (8, 0).
 * The caller places it with a transform (the indicator's group also gets the CSS orbit/wobble).
 */
function beeParts(clipId: string): SVGElement[] {
  const wings = [-4, 4].map((cx) =>
    svgNode("ellipse", {
      class: "bee-wing",
      cx: String(cx),
      cy: "-5",
      rx: "6",
      ry: "4",
      fill: "var(--surface)",
      stroke: "var(--text-3)",
      "stroke-width": "1",
      opacity: "0.9",
    }),
  );
  const body = svgNode("ellipse", {
    cx: "0",
    cy: "0",
    rx: "7",
    ry: "5",
    fill: "var(--honey)",
    "clip-path": `url(#${clipId})`,
  });
  const stripes = [-2, 2].map((x) =>
    svgNode("rect", {
      x: String(x),
      y: "-5",
      width: "2",
      height: "10",
      fill: "var(--text)",
      "clip-path": `url(#${clipId})`,
    }),
  );
  const head = svgNode("circle", { cx: "8", cy: "0", r: "3", fill: "var(--text)" });
  return [...wings, body, ...stripes, head];
}

export function createBeeIndicator(): BeeIndicator {
  const clipId = `bee-body-clip-${++clipSeq}`;

  const svg = svgNode("svg", { viewBox: "0 0 96 96", width: "96", height: "96" });
  const cell = svgNode("path", {
    class: "bee-cell",
    d: "M48 18l26 15v30L48 78 22 63V33z",
    fill: "var(--honey-soft)",
    stroke: "var(--honey)",
    "stroke-width": "3",
    "stroke-linejoin": "round",
  });
  const honey = svgNode("path", {
    class: "bee-honey",
    d: "M48 18l26 15v30L48 78 22 63V33z",
    transform: "translate(48 48) scale(0.6) translate(-48 -48)",
    fill: "var(--honey)",
  });
  const flight = svgNode("g", { class: "bee-flight" });
  const bee = svgNode("g", { class: "bee", transform: "translate(48 8)" });
  // Drawn at 1.5x so the bee reads clearly next to the cell; the animations move the outer group.
  const beeBody = svgNode("g", { transform: "scale(1.5)" });
  beeBody.append(...beeParts(clipId));
  bee.append(beeBody);
  flight.append(bee);
  svg.append(clipDefs(clipId), cell, honey, flight);

  const stage = el("div", { class: "bee-stage", "aria-hidden": "true" }, svg);
  const labelEl = el("span", { class: "bee-label", role: "status", "aria-live": "polite" });
  const timeEl = el("span", { class: "bee-time", "aria-hidden": "true" }, "0:00");
  const text = el("div", { class: "bee-text" }, labelEl, timeEl);
  const root = el("div", { class: "bee-indicator", "data-state": "queued" }, stage, text);

  let currentState: BeeState | null = null;
  let currentLabel = "";
  let startedAt = 0;
  let interval: number | undefined;

  function formatTime(ms: number): string {
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
  }

  function tick(): void {
    timeEl.textContent = formatTime(Date.now() - startedAt);
  }

  function set(state: BeeState, label: string): void {
    const changed = state !== currentState || label !== currentLabel;
    currentState = state;
    currentLabel = label;
    root.dataset.state = state;
    if (changed) labelEl.textContent = label;
    if (!startedAt) {
      startedAt = Date.now();
      tick();
    }
    const running = state === "queued" || state === "working";
    if (running && interval === undefined) {
      interval = window.setInterval(tick, 1000);
    } else if (!running && interval !== undefined) {
      window.clearInterval(interval);
      interval = undefined;
      tick();
    }
  }

  function destroy(): void {
    if (interval !== undefined) {
      window.clearInterval(interval);
      interval = undefined;
    }
  }

  return { root, set, destroy };
}

/** The small bee shown next to Runs in the header while a run is busy. */
export function headerBee(): HTMLElement {
  const clipId = `bee-body-clip-${++clipSeq}`;
  const svg = svgNode("svg", {
    width: "16",
    height: "16",
    viewBox: "-11 -11 22 22",
    "aria-hidden": "true",
  });
  svg.append(clipDefs(clipId), ...beeParts(clipId));
  return el("span", { class: "header-bee" }, svg, el("span", { class: "sr-only" }, "Run in progress"));
}
