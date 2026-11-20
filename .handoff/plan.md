## Goal

Two new CLI commands so the server and web UI are easy to run anywhere:

- `hive serve`: start the server and web UI from the CLI, on a laptop or a headless box. If no
  login token exists yet, create one and keep it in the keys file. `--open` opens the browser
  already logged in (the token travels in the URL fragment, which the UI reads and strips).
- `hive service install | status | restart | logs | uninstall`: run `hive serve` as a background
  service that starts at login/boot: a systemd user unit on Linux, a launchd agent on macOS.

## Files to touch

- `src/cli.ts`
- `src/service.ts` (new)
- `src/auth.ts`
- `src/index.ts`
- `ui/src/main.ts`
- `test/service.test.mjs` (new)
- `README.md`
- `AGENTS.md`
- `docs/ROADMAP.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `cd ui && npm ci && cd ..`, then `bash vm/build.sh`.

2. `src/auth.ts`: `loadTokens()` uses `setting("API_TOKEN")` / `setting("API_TOKENS")` from
   `./config.js` instead of reading `process.env` directly, so a token saved in the keys file
   (`~/.config/agent-hive/env`) works for the server too. Keep the existing validation (minimum
   length 16, JSON for `API_TOKENS`) and error messages.

3. `src/index.ts`: change the "no token" fatal message to
   `FATAL: no API token. Run hive serve (it creates one), or set API_TOKEN in .env or ~/.config/agent-hive/env; generate one with: openssl rand -hex 32`.
   No other behaviour change: `node dist/index.js` keeps working as today.

4. `src/cli.ts`, `hive serve [--host <addr>] [--port <n>] [--open]`:
   - Defaults: host `127.0.0.1`, port `8080` (or `HOST` / `PORT` when set and no flag is given).
     `--port` must be 1–65535.
   - If `setting("API_TOKEN")` and `setting("API_TOKENS")` are both empty: generate
     `randomBytes(24).toString("hex")`, save it with `setKeysFileValue("API_TOKEN", token)` and
     print `hive: created a login token and saved it to <keys file>`.
   - Set `process.env.HOST` / `process.env.PORT`, `process.env.API_TOKEN` (to the token now in use
     when it came from the keys file, so `loadTokens` sees it even if config was imported first),
     then `await import("./index.js")` to start the server in this process.
   - Once listening (poll `http://127.0.0.1:<port>/health` every 200 ms for up to 15 s), print:
     `hive: serving on http://<host>:<port>/ui/` and, when host is `0.0.0.0`, also the LAN
     addresses from `os.networkInterfaces()` (IPv4, not internal); then
     `hive: log in with the token in <keys file> (hive keys list does not show it; see API_TOKEN there)`.
     Never print the token itself.
   - `--open`: open `http://127.0.0.1:<port>/ui/#token=<token>` with `xdg-open` (Linux) or `open`
     (macOS) via `spawn(..., { detached: true, stdio: "ignore" }).unref()`; if that fails print the
     URL without the token and the hint above.
   - Ctrl+C stops the server (the server's own handling is fine; exit 0).
   - Add to `USAGE` / help and the README command table.

5. `src/service.ts` (new). Pure functions plus thin runners, so tests never touch the real system:
   - `export const SERVICE_NAME = "agent-hive"`.
   - `serviceCommand(o: { host: string; port: number }): string[]`: `[process.execPath, <absolute path of dist/cli.js>, "serve", "--host", host, "--port", String(port)]`
     (use `fileURLToPath(new URL("./cli.js", import.meta.url))`).
   - `systemdUnit(o: { command: string[]; workdir: string; path: string }): string`: a unit like
     ```
     [Unit]
     Description=Agent Hive server and web UI
     After=network-online.target
     Wants=network-online.target

     [Service]
     WorkingDirectory=<workdir>
     Environment=PATH=<path>
     ExecStart=<command, each argument quoted for systemd with double quotes; reject arguments containing a double quote, backslash or newline>
     Restart=on-failure
     RestartSec=10
     TimeoutStopSec=20

     [Install]
     WantedBy=default.target
     ```
   - `launchdPlist(o: { command: string[]; workdir: string; path: string; logFile: string }): string`:
     a plist with `Label` `dev.agent-hive.server`, `ProgramArguments` (each argument XML-escaped),
     `WorkingDirectory`, `EnvironmentVariables` → `PATH`, `RunAtLoad` true, `KeepAlive` →
     `SuccessfulExit` false, `StandardOutPath` and `StandardErrorPath` = `logFile`.
   - `servicePaths(platform = process.platform)`: Linux → unit file
     `$XDG_CONFIG_HOME/systemd/user/agent-hive.service` (default `~/.config/...`); macOS → plist
     `~/Library/LaunchAgents/dev.agent-hive.server.plist` and log `~/Library/Logs/agent-hive.log`.
     `HIVE_SERVICE_DIR`, when set, replaces the folder (tests and dry runs use it).
   - Runners (each calls `systemctl --user ...` or `launchctl ...` with `execFileSync`/`spawnSync`
     and argument arrays; skipped with `--dry-run`):
     - install: write the file (mode 0o644), then Linux `systemctl --user daemon-reload` and
       `systemctl --user enable --now agent-hive.service`; macOS `launchctl bootout gui/<uid>/dev.agent-hive.server`
       (ignore failure) then `launchctl bootstrap gui/<uid> <plist>`. On Linux, check
       `loginctl show-user <user> -p Linger`; if it is not `Linger=yes`, print
       `hive: to keep it running after you log out (e.g. on a headless box): sudo loginctl enable-linger <user>`.
     - status: Linux `systemctl --user status agent-hive.service --no-pager`; macOS
       `launchctl print gui/<uid>/dev.agent-hive.server` (print a short "not installed" when the file
       is missing).
     - restart: Linux `systemctl --user restart agent-hive.service`; macOS
       `launchctl kickstart -k gui/<uid>/dev.agent-hive.server`.
     - logs: Linux `journalctl --user -u agent-hive.service -f -n 100`; macOS `tail -n 100 -f <log>`.
     - uninstall: Linux `systemctl --user disable --now agent-hive.service`, delete the unit file,
       `daemon-reload`; macOS `launchctl bootout ...` and delete the plist.
     - Other platforms: throw `Error("hive service supports Linux (systemd) and macOS (launchd)")`.

6. `src/cli.ts`, `hive service <install|status|restart|logs|uninstall> [--host <addr>] [--port <n>] [--dry-run]`
   (host/port only for install; defaults `127.0.0.1` / `8080`):
   - install: before writing, if `setting("API_TOKEN")` and `setting("API_TOKENS")` are empty,
     create and save a token exactly as `hive serve` does. Use `workdir` = the user's home folder and
     `path` = the current `PATH`. Warn, without failing, for each provider whose key is present only
     in this process's shell environment (`shellEnv`) and not in the keys file:
     `hive: <LABEL> key comes from your shell; the service won't see it. Save it with: hive keys add <id>`.
     With `--dry-run`, print the file that would be written and its path, and run nothing.
     Otherwise print the file path, `hive: started; open http://<host>:<port>/ui/` and the linger hint
     when relevant.
   - Add to `USAGE` / help and the README command table.

7. `ui/src/main.ts`: at startup, before the login check, if `location.hash` starts with `#token=`,
   take the token (URL-decoded), call `saveToken`/`setToken` as the login form does, then
   `history.replaceState(null, "", "#runs")` so the token leaves the address bar and history entry.
   An invalid token falls through to the normal login screen with its error.

8. `test/service.test.mjs` (new), `node:test` style, never calling `systemctl`, `launchctl` or
   `loginctl` (set `HIVE_SERVICE_DIR`, `HIVE_KEYS_FILE` and `HIVE_DOTENV_PATH` to temp paths):
   - `systemdUnit` contains `ExecStart="<node>" "<cli.js>" "serve" "--host" "0.0.0.0" "--port" "8080"`,
     `Restart=on-failure` and `WantedBy=default.target`; an argument with a double quote throws.
   - `launchdPlist` is well-formed enough that `ProgramArguments` lists each argument in its own
     `<string>`, escapes `&` and `<`, and contains `RunAtLoad` and the log path.
   - `servicePaths("linux")` and `servicePaths("darwin")` use `HIVE_SERVICE_DIR`.
   - `spawnSync(process.execPath, ["dist/cli.js", "service", "install", "--host", "0.0.0.0", "--dry-run"], { env: {...process.env, HIVE_SERVICE_DIR: dir, HIVE_KEYS_FILE: keys} })`
     exits 0, prints the unit (or the plist on macOS) and creates no file in `dir`; afterwards the
     keys file contains an `API_TOKEN=` line of 48 hex characters, and stdout does not contain that
     token.
   - `hive serve` is not started in tests.

9. `README.md`: a "Run it as a service" section: `hive serve` (laptop, on demand, `--open`),
   `hive service install` (starts at login/boot; Linux user service with the linger note for
   headless boxes; macOS launchd agent), `hive service status|restart|logs|uninstall`, that keys must
   be in the keys file for the service (`hive keys add`), and that the login token lives in the keys
   file as `API_TOKEN`. Add both commands to the command table. `AGENTS.md`: layout row for
   `src/service.ts`; `src/cli.ts` row mentions `serve` and `service`. `docs/ROADMAP.md`: mark
   `hive serve` as started (the server now runs from the CLI; the server code is still the
   separate `src/index.ts` core).

## Acceptance

- `npm test` exits 0 and includes `test/service.test.mjs` passing.
- `npm run build:ui` exits 0.
- `HIVE_SERVICE_DIR=$(mktemp -d) HIVE_KEYS_FILE=$(mktemp -d)/env node dist/cli.js service install --dry-run`
  exits 0 and prints a systemd unit containing `serve`.
- `node dist/cli.js --help` lists `hive serve` and `hive service`.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never run `systemctl`, `launchctl`,
  `loginctl` or `journalctl` for real, never start `hive serve` or the server, and never write to
  the real `~/.config/systemd`, `~/Library` or `~/.config/agent-hive/env` (tests use the override
  variables). If something outside Acceptance fails, note it in the report and finish.
- Never print or log the login token. Commands run with argument arrays, never a shell.
- No new dependencies.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- The desktop tray app (next step), Windows, changing the server code beyond steps 2–3, TLS or
  tunnels.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
