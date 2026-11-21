/**
 * `hive service`: run `hive serve` in the background, at login/boot. Linux gets a systemd user
 * unit, macOS a launchd agent. Everything that builds the service file is a pure function, so the
 * tests can check the file without ever calling systemctl, launchctl or loginctl.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_NAME = "agent-hive";

/** The launchd label (macOS) of the service. */
export const SERVICE_LABEL = "dev.agent-hive.server";

export interface ServiceTarget {
  host: string;
  port: number;
}

/** The command a service runs: this Node binary and this checkout's CLI, serving. */
export function serviceCommand(o: ServiceTarget): string[] {
  return [
    process.execPath,
    fileURLToPath(new URL("./cli.js", import.meta.url)),
    "serve",
    "--host",
    o.host,
    "--port",
    String(o.port),
    "--no-open",
  ];
}

function systemdQuote(arg: string): string {
  if (/["\\\r\n]/.test(arg)) {
    throw new Error(
      `cannot put an argument containing a double quote, backslash or newline in a systemd unit: ${arg}`,
    );
  }
  return `"${arg}"`;
}

/** The systemd user unit `hive service install` writes on Linux. */
export function systemdUnit(o: { command: string[]; workdir: string; path: string }): string {
  const execStart = o.command.map(systemdQuote).join(" ");
  return (
    [
      "[Unit]",
      "Description=Agent Hive server and web UI",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      `WorkingDirectory=${o.workdir}`,
      `Environment=PATH=${o.path}`,
      `ExecStart=${execStart}`,
      "Restart=on-failure",
      "RestartSec=10",
      "TimeoutStopSec=20",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n")
  );
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The launchd agent `hive service install` writes on macOS. */
export function launchdPlist(o: { command: string[]; workdir: string; path: string; logFile: string }): string {
  const args = o.command.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(o.workdir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(o.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(o.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(o.logFile)}</string>
</dict>
</plist>
`;
}

export interface ServiceFiles {
  file: string;
  logFile?: string;
}

/**
 * Where the service file lives. `HIVE_SERVICE_DIR` overrides the folder (tests and dry runs use
 * it), so a dry run never touches the real systemd or launchd configuration.
 */
export function servicePaths(platform: string = process.platform): ServiceFiles {
  if (platform === "linux") {
    const dir =
      process.env.HIVE_SERVICE_DIR ||
      join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
    return { file: join(dir, `${SERVICE_NAME}.service`) };
  }
  if (platform === "darwin") {
    const dir = process.env.HIVE_SERVICE_DIR || join(homedir(), "Library", "LaunchAgents");
    return {
      file: join(dir, `${SERVICE_LABEL}.plist`),
      logFile: join(homedir(), "Library", "Logs", "agent-hive.log"),
    };
  }
  throw new Error("hive service supports Linux (systemd) and macOS (launchd)");
}

function assertPlatform(platform: string): asserts platform is "linux" | "darwin" {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error("hive service supports Linux (systemd) and macOS (launchd)");
  }
}

function uid(): number {
  return process.getuid?.() ?? 0;
}

interface RunnerCommand {
  argv: string[];
  /** A command that may legitimately fail (e.g. stopping a service that isn't running). */
  ignoreFailure?: boolean;
}

/** Run the commands with argument arrays; with `dryRun` only show what would run. */
function runCommands(commands: RunnerCommand[], dryRun: boolean): void {
  for (const command of commands) {
    if (dryRun) {
      process.stdout.write(`hive: would run: ${command.argv.join(" ")}\n`);
      continue;
    }
    try {
      execFileSync(command.argv[0], command.argv.slice(1), { stdio: "inherit" });
    } catch (err) {
      if (!command.ignoreFailure) throw err;
    }
  }
}

/** The linger hint for headless Linux boxes, or undefined when lingering is already on. */
function lingerHint(): string | undefined {
  const user = userInfo().username;
  let linger = "";
  try {
    linger = execFileSync("loginctl", ["show-user", user, "-p", "Linger"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // No systemd-logind (or loginctl): still worth suggesting linger.
  }
  if (linger === "Linger=yes") return undefined;
  return `hive: to keep it running after you log out (e.g. on a headless box): sudo loginctl enable-linger ${user}`;
}

export interface InstallOptions extends ServiceTarget {
  platform?: string;
  dryRun?: boolean;
}

export interface InstallResult {
  file: string;
  content: string;
  /** Printed by the caller after a real install, when lingering is off. */
  lingerHint?: string;
}

/**
 * Write the service file and load it. With `dryRun` nothing is written and nothing runs; the file
 * content and path are returned for the caller to print.
 */
export function installService(o: InstallOptions): InstallResult {
  const platform = o.platform ?? process.platform;
  assertPlatform(platform);
  const paths = servicePaths(platform);
  const command = serviceCommand(o);
  const content =
    platform === "linux"
      ? systemdUnit({ command, workdir: homedir(), path: process.env.PATH || "" })
      : launchdPlist({ command, workdir: homedir(), path: process.env.PATH || "", logFile: paths.logFile! });
  const result: InstallResult = { file: paths.file, content };
  if (o.dryRun) return result;

  mkdirSync(dirname(paths.file), { recursive: true });
  writeFileSync(paths.file, content, { mode: 0o644 });
  chmodSync(paths.file, 0o644);

  if (platform === "linux") {
    runCommands(
      [
        { argv: ["systemctl", "--user", "daemon-reload"] },
        { argv: ["systemctl", "--user", "enable", "--now", `${SERVICE_NAME}.service`] },
      ],
      false,
    );
    result.lingerHint = lingerHint();
  } else {
    runCommands(
      [
        { argv: ["launchctl", "bootout", `gui/${uid()}/${SERVICE_LABEL}`], ignoreFailure: true },
        { argv: ["launchctl", "bootstrap", `gui/${uid()}`, paths.file] },
      ],
      false,
    );
  }
  return result;
}

/** Print the service's state. `installed` is false when the service file is missing. */
export function statusService(o: { platform?: string; dryRun?: boolean } = {}): { installed: boolean } {
  const platform = o.platform ?? process.platform;
  assertPlatform(platform);
  const { file } = servicePaths(platform);
  if (!existsSync(file)) return { installed: false };
  const argv =
    platform === "linux"
      ? ["systemctl", "--user", "status", `${SERVICE_NAME}.service`, "--no-pager"]
      : ["launchctl", "print", `gui/${uid()}/${SERVICE_LABEL}`];
  runCommands([{ argv, ignoreFailure: true }], o.dryRun ?? false);
  return { installed: true };
}

export function restartService(o: { platform?: string; dryRun?: boolean } = {}): void {
  const platform = o.platform ?? process.platform;
  assertPlatform(platform);
  const argv =
    platform === "linux"
      ? ["systemctl", "--user", "restart", `${SERVICE_NAME}.service`]
      : ["launchctl", "kickstart", "-k", `gui/${uid()}/${SERVICE_LABEL}`];
  runCommands([{ argv }], o.dryRun ?? false);
}

/** Follow the service's log (blocks until Ctrl+C). Returns the command's exit status. */
export function logsService(o: { platform?: string; dryRun?: boolean } = {}): number {
  const platform = o.platform ?? process.platform;
  assertPlatform(platform);
  const { logFile } = servicePaths(platform);
  const argv =
    platform === "linux"
      ? ["journalctl", "--user", "-u", `${SERVICE_NAME}.service`, "-f", "-n", "100"]
      : ["tail", "-n", "100", "-f", logFile!];
  if (o.dryRun) {
    process.stdout.write(`hive: would run: ${argv.join(" ")}\n`);
    return 0;
  }
  return spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }).status ?? 0;
}

/** Stop the service and delete its file. */
export function uninstallService(o: { platform?: string; dryRun?: boolean } = {}): { file: string } {
  const platform = o.platform ?? process.platform;
  assertPlatform(platform);
  const paths = servicePaths(platform);
  if (platform === "linux") {
    runCommands([{ argv: ["systemctl", "--user", "disable", "--now", `${SERVICE_NAME}.service`] }], o.dryRun ?? false);
    if (!o.dryRun) rmSync(paths.file, { force: true });
    runCommands([{ argv: ["systemctl", "--user", "daemon-reload"] }], o.dryRun ?? false);
  } else {
    runCommands(
      [{ argv: ["launchctl", "bootout", `gui/${uid()}/${SERVICE_LABEL}`], ignoreFailure: true }],
      o.dryRun ?? false,
    );
    if (!o.dryRun) rmSync(paths.file, { force: true });
  }
  return { file: paths.file };
}
