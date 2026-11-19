export const STORAGE_KEY = "hive_token";
export const serverUrl = window.location.origin;

function readStoredToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

let token = readStoredToken();

export const getToken = () => token;
export const setToken = (t: string) => {
  token = t;
};

/** Persist the current token; storage can be unavailable (private mode, blocked cookies). */
export function saveToken(): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {}
}

/** Forget the current token, in memory and in storage. */
export function clearToken(): void {
  token = "";
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Create an element. Attributes are set with setAttribute (so class, id, type, for, aria-* and
 * data-* all work); string children become text nodes (never HTML) and element children are
 * appended as-is. Nothing here parses markup.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | null | undefined>,
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K];
export function el(
  tag: string,
  attrs: Record<string, string | null | undefined>,
  ...children: (Node | string | null | undefined)[]
): HTMLElement;
export function el(
  tag: string,
  attrs: Record<string, string | null | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function api(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${serverUrl}${path}`, {
    ...opts,
    // Content-Type only with a body: Fastify rejects an empty body declared as JSON.
    headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
  });
}
