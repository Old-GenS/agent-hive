// Distro- and WSL-aware fix commands: hostInfo() on sample os-release/proc-version strings, and
// fixFor() for every check on Fedora, Ubuntu, WSL and from a bundle vs a source checkout.
import test from "node:test";
import assert from "node:assert/strict";

// Before any dist module loads: hostInfo()'s bundle default must not pick up the test runner's env.
delete process.env.HIVE_BUNDLE_ROOT;

const { fixFor, hostInfo } = await import("../dist/fixes.js");

const FEDORA = `NAME="Fedora Linux"\nID=fedora\nVERSION_ID=41\n`;
const UBUNTU = `NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n`;
const ROCKY = `NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n`;
const ARCH = `NAME="Arch Linux"\nID=arch\n`;
const LINUX = "Linux version 6.12.109 (build@host) #1 SMP";
const WSL = "Linux version 5.15.153.1-microsoft-standard-WSL2 (root@build) #1 SMP";

const fedora = hostInfo({ osRelease: FEDORA, procVersion: LINUX, bundle: false });
const ubuntu = hostInfo({ osRelease: UBUNTU, procVersion: LINUX, bundle: false });
const rocky = hostInfo({ osRelease: ROCKY, procVersion: LINUX, bundle: false });
const arch = hostInfo({ osRelease: ARCH, procVersion: LINUX, bundle: false });
const wsl = hostInfo({ osRelease: UBUNTU, procVersion: WSL, bundle: false });

test("hostInfo parses ID and ID_LIKE", () => {
  assert.equal(fedora.distro, "fedora");
  assert.deepEqual(fedora.distroLike, []);
  assert.equal(ubuntu.distro, "ubuntu");
  assert.deepEqual(ubuntu.distroLike, ["debian"]);
  // Rocky is the dnf family only through ID_LIKE.
  assert.equal(rocky.distro, "rocky");
  assert.deepEqual(rocky.distroLike, ["rhel", "centos", "fedora"]);
});

test("hostInfo detects WSL from /proc/version, case-insensitively", () => {
  assert.equal(wsl.wsl, true);
  assert.equal(hostInfo({ osRelease: FEDORA, procVersion: "Linux version 5.15.0 WSL2" }).wsl, true);
  assert.equal(hostInfo({ osRelease: FEDORA, procVersion: "Linux version 5.15.0 microsoft-standard" }).wsl, true);
  assert.equal(hostInfo({ osRelease: FEDORA, procVersion: LINUX }).wsl, false);
});

test("hostInfo falls back to unknown for missing input", () => {
  const missing = hostInfo({ osRelease: "", procVersion: "" });
  assert.equal(missing.distro, "unknown");
  assert.deepEqual(missing.distroLike, []);
  assert.equal(missing.wsl, false);
});

test("hostInfo trusts an explicit bundle flag", () => {
  assert.equal(hostInfo({ osRelease: FEDORA, procVersion: LINUX, bundle: true }).bundle, true);
  assert.equal(hostInfo({ osRelease: FEDORA, procVersion: LINUX, bundle: false }).bundle, false);
});

test("fixFor kvm: WSL turns on nested virtualization, else BIOS/UEFI", () => {
  const onWsl = fixFor("kvm", wsl);
  assert.match(onWsl.text, /nestedVirtualization=true/);
  assert.match(onWsl.text, /%UserProfile%\\\.wslconfig/);
  assert.match(onWsl.text, /\[wsl2\]/);
  assert.equal(onWsl.command, "wsl --shutdown");

  const bareMetal = fixFor("kvm", fedora);
  assert.match(bareMetal.text, /BIOS or UEFI/);
  assert.match(bareMetal.text, /nested virtualization/);
  assert.equal(bareMetal.command, undefined);
});

test("fixFor libkrun: dnf family installs it; Debian/Ubuntu isn't packaged yet", () => {
  assert.equal(fixFor("libkrun", fedora).command, "sudo dnf install libkrun");
  assert.equal(fixFor("libkrun", rocky).command, "sudo dnf install libkrun");
  const deb = fixFor("libkrun", ubuntu);
  assert.equal(deb.command, undefined);
  assert.match(deb.text, /isn't packaged/);
  assert.match(deb.text, /Fedora/);
  const other = fixFor("libkrun", hostInfo({ osRelease: "ID=gentoo\n", procVersion: LINUX, bundle: false }));
  assert.equal(other.command, undefined);
  assert.match(other.text, /https:\/\/github\.com\/containers\/libkrun/);
});

test("fixFor pasta: one install command per package manager", () => {
  assert.equal(fixFor("pasta", fedora).command, "sudo dnf install passt");
  assert.equal(fixFor("pasta", rocky).command, "sudo dnf install passt");
  assert.equal(fixFor("pasta", ubuntu).command, "sudo apt install passt");
  assert.equal(fixFor("pasta", arch).command, "sudo pacman -S passt");
  const other = fixFor("pasta", hostInfo({ osRelease: "ID=gentoo\n", procVersion: LINUX, bundle: false }));
  assert.equal(other.command, undefined);
  assert.match(other.text, /https:\/\/passt\.top/);
});

test("fixFor launcher: a bundle is reinstalled, a checkout is rebuilt", () => {
  const bundle = fixFor("launcher", { ...fedora, bundle: true });
  assert.match(bundle.command ?? "", /install-cli\.sh/);
  assert.match(bundle.command ?? "", /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/ogsapps\/agent-hive\/main\/install-cli\.sh \| sh$/);
  assert.match(bundle.text, /Reinstall hive/);
  assert.equal(fixFor("launcher", { ...fedora, bundle: false }).command, "npm run build:vm");
});

test("fixFor rootfs: a bundle downloads it, a checkout builds it", () => {
  const bundle = fixFor("rootfs", { ...fedora, bundle: true });
  assert.equal(bundle.command, "hive setup");
  assert.equal(fixFor("rootfs", { ...fedora, bundle: false }).command, "npm run build:image && npm run build:rootfs");
});
