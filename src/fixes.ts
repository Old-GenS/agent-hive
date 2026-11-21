/**
 * The fix a user should try for a failed system check, in their distro's own words.
 *
 * Pure functions: hostInfo() reads /etc/os-release and /proc/version (or takes them as strings for
 * tests), and fixFor() returns one plain sentence plus, when there is one, a single copyable
 * command. The web UI's first-run flow and `hive doctor` both print the same text.
 */
import { readFileSync } from "node:fs";
import { bundleRoot } from "./release.js";

export interface HostInfo {
  /** ID from /etc/os-release, lowercased, or "unknown". */
  distro: string;
  /** ID_LIKE from /etc/os-release, split on whitespace and lowercased. */
  distroLike: string[];
  /** Linux under WSL (the kernel version mentions microsoft/WSL). */
  wsl: boolean;
  /** Running from an installed release bundle rather than a source checkout. */
  bundle: boolean;
}

export type CheckId = "kvm" | "libkrun" | "pasta" | "launcher" | "rootfs";

export interface Fix {
  /** One plain sentence: what to do. */
  text: string;
  /** A single command the user can copy, when the fix is one command. */
  command?: string;
}

const INSTALL_CLI = "curl -fsSL https://raw.githubusercontent.com/ogsapps/agent-hive/main/install-cli.sh | sh";

/** The unquoted value of a KEY=value line in /etc/os-release. */
function osReleaseField(text: string, key: string): string | undefined {
  for (const raw of text.split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!match || match[1] !== key) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/**
 * What this computer runs: the distro family from /etc/os-release, whether the kernel is WSL, and
 * whether hive is an installed release. Missing files give distro "unknown" and wsl false. Passing
 * the file contents in overrides the real files, so tests can use sample strings.
 */
export function hostInfo(o: { osRelease?: string; procVersion?: string; bundle?: boolean } = {}): HostInfo {
  let osRelease = o.osRelease;
  if (osRelease === undefined) {
    try {
      osRelease = readFileSync("/etc/os-release", "utf8");
    } catch {
      osRelease = "";
    }
  }
  let procVersion = o.procVersion;
  if (procVersion === undefined) {
    try {
      procVersion = readFileSync("/proc/version", "utf8");
    } catch {
      procVersion = "";
    }
  }
  const distro = (osReleaseField(osRelease, "ID") ?? "").toLowerCase() || "unknown";
  const distroLike = (osReleaseField(osRelease, "ID_LIKE") ?? "")
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
  return {
    distro,
    distroLike,
    wsl: /microsoft|wsl/i.test(procVersion),
    bundle: o.bundle ?? bundleRoot() !== undefined,
  };
}

/** Every ID this host answers to: its own and its parents from ID_LIKE. */
function ids(host: HostInfo): string[] {
  return [host.distro, ...host.distroLike];
}

function hasId(host: HostInfo, ...names: string[]): boolean {
  return names.some((name) => ids(host).includes(name));
}

/** Fedora, RHEL, CentOS, Rocky and Alma all resolve to the dnf family (via ID or ID_LIKE). */
function dnfFamily(host: HostInfo): boolean {
  return ids(host).some((id) => id.includes("fedora") || id.includes("rhel"));
}

function debianFamily(host: HostInfo): boolean {
  return hasId(host, "debian", "ubuntu");
}

/** The exact text and command that fix one failed check on this host. */
export function fixFor(check: CheckId, host: HostInfo): Fix {
  switch (check) {
    case "kvm":
      if (host.wsl) {
        return {
          text: "Turn on nested virtualization: in %UserProfile%\\.wslconfig put nestedVirtualization=true under [wsl2], then run wsl --shutdown in Windows.",
          command: "wsl --shutdown",
        };
      }
      return {
        text: "Enable virtualization (Intel VT-x or AMD-V) in the BIOS or UEFI settings; on a cloud VM, pick a machine type with nested virtualization.",
      };

    case "libkrun":
      if (dnfFamily(host)) {
        return { text: "Install the libkrun package for this distro.", command: "sudo dnf install libkrun" };
      }
      if (debianFamily(host)) {
        return {
          text: "libkrun isn't packaged for Debian or Ubuntu yet; a bundled libkrun is planned, and Fedora works today (on WSL, the Fedora WSL distro).",
        };
      }
      return { text: "Build or install libkrun from https://github.com/containers/libkrun." };

    case "pasta":
      if (dnfFamily(host)) return { text: "Install passt, which provides pasta.", command: "sudo dnf install passt" };
      if (debianFamily(host)) return { text: "Install passt, which provides pasta.", command: "sudo apt install passt" };
      if (hasId(host, "arch")) return { text: "Install passt, which provides pasta.", command: "sudo pacman -S passt" };
      return { text: "Install passt from https://passt.top." };

    case "launcher":
      if (host.bundle) {
        return { text: "Reinstall hive with the installer line from the README.", command: INSTALL_CLI };
      }
      return { text: "Build the VM launcher from this checkout.", command: "npm run build:vm" };

    case "rootfs":
      if (host.bundle) {
        return { text: "Download the VM filesystem with hive setup.", command: "hive setup" };
      }
      return {
        text: "Build the sandbox image and the VM filesystem from this checkout.",
        command: "npm run build:image && npm run build:rootfs",
      };
  }
}
