export const STORAGE_KEY = "hive_token";
export const serverUrl = window.location.origin;
let token = localStorage.getItem(STORAGE_KEY) || "";

export const getToken = () => token;
export const setToken = (t: string) => { token = t; };

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function api(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${serverUrl}${path}`, {
    ...opts,
    // Content-Type only with a body: Fastify rejects an empty body declared as JSON.
    headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
  });
}
