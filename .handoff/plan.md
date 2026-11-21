## Goal

Real LAN isolation for every hive VM, with an egress proxy. Today pasta gives the VM the internet
and blocks this computer (`--no-map-gw`), but other devices on the LAN (router, NAS, printers) are
reachable, and the docs wrongly say they aren't.

New design (verified by hand on this machine): pasta runs **without** `--config-net` and with
`-T <port>`, so the VM's only way out is `127.0.0.1:<port>`, which pasta forwards to the same port
on the host's loopback. hive runs a small HTTP/HTTPS proxy there that resolves each destination
itself and refuses every non-public address (after resolving, connecting to the vetted address, so
DNS rebinding can't get around it). Tools in the VM use it through the standard proxy variables.
Non-HTTP traffic (raw TCP, UDP, SSH) no longer leaves the VM; that's intended.

## Files to touch

- `src/egress.ts` (new)
- `src/sandbox.ts`
- `src/config.ts`
- `src/runs.ts` (only if needed to pass the proxy env/port; see step 4)
- `test/egress.test.mjs` (new)
- `test/sandbox.test.mjs`
- `README.md`, `docs/HOW-IT-WORKS.md`, `docs/ROADMAP.md`, `docs/CONFIGURATION.md`, `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `src/egress.ts` (new), Node built-ins only (`node:http`, `node:net`, `node:dns`, `node:crypto`):
   - `export function isPublicAddress(ip: string): boolean` — false for anything not a valid IP
     and for every non-public range, using `net.BlockList`:
     IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`,
     `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`,
     `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`;
     IPv6 `::/128`, `::1/128`, `::ffff:0:0/96` (check the embedded IPv4 with the IPv4 list
     instead of blocking it outright), `64:ff9b::/96` and `64:ff9b:1::/48` (same: check the
     embedded IPv4), `100::/64`, `2001:db8::/32`, `fc00::/7`, `fe80::/10`, `ff00::/8`.
   - `export interface EgressProxy { port: number; url: string; env: Record<string, string>;
     close(): Promise<void> }`.
   - `export async function startEgressProxy(o: { lookup?: (host: string) => Promise<string[]>;
     allow?: (ip: string) => boolean; log?: (line: string) => void } = {}): Promise<EgressProxy>`
     - Listens on `127.0.0.1`, port 0 (ephemeral). `lookup` defaults to
       `dns.promises.lookup(host, { all: true, verbatim: true })` mapped to addresses; `allow`
       defaults to `isPublicAddress`.
     - A random token (`randomBytes(24).toString("hex")`); every request must carry
       `Proxy-Authorization: Basic base64("hive:<token>")`, else `407` with
       `Proxy-Authenticate: Basic realm="hive"`. `url` is `http://hive:<token>@127.0.0.1:<port>`.
     - **CONNECT host:port** (HTTPS and any TLS): parse host and port (port 1–65535 required);
       resolve (an IP literal skips lookup); if no address resolves → `502`; if **any** resolved
       address fails `allow` → `403` and log `denied <host>:<port> (<ip>)`; else open
       `net.connect` to the **first allowed address** (never the hostname), reply
       `HTTP/1.1 200 Connection Established`, then pipe both ways; destroy both sockets on error
       or close.
     - **Plain HTTP** (absolute-form `GET http://host[:port]/path`): same resolve/allow check;
       forward with `http.request` to the vetted IP, `Host` header set to the original host,
       request headers copied except `proxy-authorization`, `proxy-connection`; stream the
       response back. A request that isn't absolute-form → `400`.
     - Never follow redirects itself (the client does, through the proxy again).
     - `env`: `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` = `url`;
       `NO_PROXY` and `no_proxy` = `localhost,127.0.0.1,::1`; `NODE_USE_ENV_PROXY` = `1` (Node 24's
       fetch and http then honour the proxy variables; pi runs on Node 24).
     - `close()` stops listening and destroys open sockets.
   - `export async function sharedEgressProxy(): Promise<EgressProxy>` — one proxy per process,
     started on first use (memoized promise); its server is `unref()`'d so it never keeps the
     process alive. Log lines go to `console.error` only when `HIVE_EGRESS_DEBUG=1`.

3. `src/config.ts`: `sandbox.network: process.env.HIVE_NETWORK || "proxy"` with a comment:
   `proxy` (default) = the VM reaches only hive's egress proxy, which refuses this computer and
   the local network; `direct` = the old behaviour (pasta's own network: internet and LAN, not
   this computer). Any other value → throw `HIVE_NETWORK must be proxy or direct`.

4. `src/sandbox.ts`:
   - `buildLibkrunCommand` gets an optional `proxyPort?: number` in its `p` argument.
     - With `proxyPort`: pasta args are `["-q", "-T", String(proxyPort), "-U", "none",
       "--no-map-gw", "--", "/usr/bin/env", vmBin, ...]` — **no** `--config-net`, no
       `--dns-forward`, no `--dns-host`; and the launcher gets **no** `--dns`.
     - Without it: exactly today's args (`--config-net`, `-T none`, `--dns-forward`, the optional
       `--dns-host`, launcher `--dns 169.254.1.53`).
   - `runSandbox` becomes `async`-safe without changing its callers' contract if possible: it
     needs the proxy before spawning. Implement by starting the shared proxy in `runSandbox`
     (await inside the existing promise chain) when `config.sandbox.network === "proxy"`, adding
     `proxy.env` to the VM's env (names go through `--env NAME` like the other env vars, values via
     the child's environment, never argv), and passing `proxyPort: proxy.port`. If `runSandbox`
     must become `async`, update its two callers in `src/runs.ts` (`runSandbox(` at the export step
     and the agent step) and keep every other behaviour identical.
   - The pasta check detail text (`"VMs reach the internet, not this computer or the local
     network"`) becomes `"VMs reach the internet through hive's proxy, not this computer or the
     local network"` when network is `proxy`, and `"VMs reach the internet and the local network,
     not this computer (HIVE_NETWORK=direct)"` when `direct`.

5. Tests:
   - `test/egress.test.mjs` (new):
     - `isPublicAddress`: true for `1.1.1.1`, `8.8.8.8`, `2606:4700::1111`; false for `127.0.0.1`,
       `10.1.2.3`, `172.20.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`,
       `224.0.0.1`, `::1`, `fe80::1`, `fd00::1`, `::ffff:192.168.1.1`, `::ffff:10.0.0.1`,
       `64:ff9b::a00:1`, `not-an-ip`; true for `::ffff:1.1.1.1`.
     - Proxy with a fake `lookup` and a local target: start an `http` server and a raw TCP echo
       server on 127.0.0.1; start the proxy with `allow: () => true` and `lookup` mapping
       `example.test` → `["127.0.0.1"]`:
       - no `Proxy-Authorization` → 407;
       - CONNECT `example.test:<echo port>` with auth → `200 Connection Established`, then bytes
         echo back;
       - plain `GET http://example.test:<http port>/x` with auth → the http server's body, and the
         server saw `Host: example.test:<port>`.
     - Same proxy setup but default `allow` (`isPublicAddress`): CONNECT to `127.0.0.1:<port>`,
       to a name resolving to `192.168.1.1`, and to a name resolving to `["1.1.1.1",
       "10.0.0.1"]` → 403 each, and `log` received a `denied` line; an unresolvable name → 502.
     - `env` has all seven variables with the right values.
   - `test/sandbox.test.mjs`: `buildLibkrunCommand` with `proxyPort: 41234` → pasta args start
     `["-q", "-T", "41234", "-U", "none", "--no-map-gw", "--"]`, contain no `--config-net`,
     `--dns-forward`, `--dns-host` and no launcher `--dns`; the existing no-proxy test still
     passes unchanged.

6. Docs (fix the false LAN claims; describe the proxy):
   - `README.md` line ~21: "and a network that reaches the internet only through a proxy hive
     runs, which refuses your computer and your local network (router, NAS, other devices)."
     Line ~177 (passt thanks): pasta gives each VM its one way out, to that proxy, without root.
   - `docs/HOW-IT-WORKS.md`: the "VM can't" table row stays true now ("reach your computer, your
     router or your local network"); replace the network paragraph (around line 72) with how it
     works: pasta forwards only one port, the proxy resolves and refuses non-public addresses
     after resolving, HTTP/HTTPS only (raw TCP, UDP and SSH don't leave the VM), the proxy
     variables, `HIVE_NETWORK=direct` as the opt-out (LAN reachable).
   - `docs/ROADMAP.md`: the networking paragraph at the end ("pasta gives the guest the internet
     while blocking the host's loopback, gateway and LAN") — correct it: pasta blocks this
     computer but not the LAN; LAN isolation comes from the egress proxy (done); the per-run
     allowlist (item 2 under Later) now only needs an allowlist in that proxy. Line ~197 (gVisor
     spike): replace "but not the host or the LAN" with "only through hive's egress proxy".
   - `docs/CONFIGURATION.md` "Runs and the VM": add `HIVE_NETWORK` (`proxy` / `direct`).
   - `AGENTS.md` security rules: add a rule: the VM's only network path is hive's egress proxy
     (`src/egress.ts`), which allows public addresses only, checked after resolving and connected
     by address; `HIVE_NETWORK=direct` is the explicit opt-out. Layout table: `src/egress.ts`.

## Acceptance

- `npm run build` exits 0.
- `npm test` exits 0.
- `node --test test/egress.test.mjs test/sandbox.test.mjs` exits 0 (after `npm run build`).
- `grep -rn "not your machine or your LAN" README.md` prints nothing.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never boot a hive VM, start `hive run`,
  start the server or call GitHub/OpenRouter (VM behaviour is verified on the host afterwards).
  The tests must not need the internet. If something outside Acceptance fails, note it in the
  report and finish.
- No new npm dependencies. Don't change `vm/`, `image/` or `ui/`.
- Never mention pi-vm or dsh in docs or code.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- A per-run allowlist, UI changes, dsh-vm/pi-vm, IPv6 egress beyond the address checks.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
