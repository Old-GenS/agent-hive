/**
 * Which kind of build this server is running: a test build gets `channel: "test"` and its release
 * tag as the label, so the web UI can show a banner that it is not a release. A stable release or
 * a source checkout sets neither variable, so `buildInfo()` is `undefined` and no banner appears.
 *
 * `scripts/try-test-build.sh --serve` and `scripts/test-server.sh` set the two variables.
 */

/** The shape `/health` and `/api/system` report as `build`. */
export interface BuildInfo {
  channel: string;
  /** May be empty: the channel alone is enough to show the banner. */
  label: string;
}

/** Channels are short, lower-case, and made of letters, digits and dashes. */
const CHANNEL_RE = /^[a-z0-9-]{1,20}$/;

/** The middle dot ` · ` separates the label's pieces in the scripts. */
const MIDDLE_DOT = "\u00b7";
const LABEL_MAX = 100;

/**
 * Remove everything a label may not carry: a terminal escape or a line break would be rendered
 * (the UI sets it with `textContent`, but there is no point shipping it), and anything outside
 * printable ASCII and the middle dot is dropped. Then cut it to 100 characters.
 */
function cleanLabel(raw: string): string {
  const kept: string[] = [];
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || char === MIDDLE_DOT) kept.push(char);
    if (kept.length >= LABEL_MAX) break;
  }
  return kept.join("");
}

/** The build label from the environment, or `undefined` for a release/source build. Pure. */
export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo | undefined {
  const channel = (env.HIVE_BUILD_CHANNEL ?? "").trim();
  if (!CHANNEL_RE.test(channel)) return undefined;
  return { channel, label: cleanLabel((env.HIVE_BUILD_LABEL ?? "").trim()) };
}
