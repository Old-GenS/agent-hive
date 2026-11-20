// Watchdog tests for the libkrun launcher: --timeout, --watch-pid and signal forwarding.
//
// These run the real vm/hive-vm launcher, but point HIVE_LIBKRUN at a fake libkrun built from C in
// a temp dir, so the "VM" is just a process that sleeps for 60 s. No real VM boots. A normal run
// refuses without a usable /dev/kvm (before it reaches libkrun), so the file is skipped then too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(repoRoot, "vm", "hive-vm");

const FAKE_KRUN = String.raw`
#include <stdbool.h>
#include <stdint.h>
#include <unistd.h>

int32_t krun_set_log_level(uint32_t level) { (void)level; return 0; }
int32_t krun_create_ctx(void) { return 1; }
int32_t krun_free_ctx(uint32_t ctx_id) { (void)ctx_id; return 0; }
int32_t krun_set_vm_config(uint32_t ctx_id, uint8_t num_vcpus, uint32_t ram_mib) {
  (void)ctx_id; (void)num_vcpus; (void)ram_mib; return 0;
}
int32_t krun_add_virtiofs3(uint32_t ctx_id, const char *c_tag, const char *c_path,
                           uint64_t shm_size, bool read_only) {
  (void)ctx_id; (void)c_tag; (void)c_path; (void)shm_size; (void)read_only; return 0;
}
int32_t krun_set_workdir(uint32_t ctx_id, const char *workdir_path) {
  (void)ctx_id; (void)workdir_path; return 0;
}
int32_t krun_set_exec(uint32_t ctx_id, const char *exec_path, const char *const argv[],
                      const char *const envp[]) {
  (void)ctx_id; (void)exec_path; (void)argv; (void)envp; return 0;
}
int32_t krun_set_rlimits(uint32_t ctx_id, const char *const rlimits[]) {
  (void)ctx_id; (void)rlimits; return 0;
}
int32_t krun_set_port_map(uint32_t ctx_id, const char *const port_map[]) {
  (void)ctx_id; (void)port_map; return 0;
}
int32_t krun_start_enter(uint32_t ctx_id) { (void)ctx_id; sleep(60); return 0; }
`;

function skipReason() {
  assert.ok(existsSync(bin), `vm/hive-vm is missing; build it with: bash vm/build.sh`);
  const cc = spawnSync("cc", ["--version"], { encoding: "utf8" });
  if (cc.error || cc.status !== 0) return "no C compiler (cc)";
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch {
    return "/dev/kvm is not usable; a normal launcher run refuses before loading libkrun";
  }
  return false;
}

const skipped = skipReason();

/** Spawn the launcher in its own process group, collecting stdout/stderr and the exit. */
function startLauncher(args, env) {
  const child = spawn(bin, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

/** Wait for a process to exit; throws after `ms` (the caller kills whatever is left in finally). */
function waitForExit(exited, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  return Promise.race([exited, timeout]).finally(() => clearTimeout(timer));
}

/** SIGKILL a whole detached process group; ignores an already-dead group. */
function killGroup(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: already gone.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ESRCH: already gone.
  }
}

test("hive-vm watchdog", { skip: skipped }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), "hive-vm-watchdog-"));
  const rootfs = join(base, "rootfs");
  mkdirSync(rootfs);
  const fakeSrc = join(base, "fake.c");
  const fakeSo = join(base, "libfakekrun.so");
  writeFileSync(fakeSrc, FAKE_KRUN);
  const compiled = spawnSync("cc", ["-shared", "-fPIC", "-o", fakeSo, fakeSrc], { encoding: "utf8" });
  assert.equal(compiled.status, 0, `cc failed: ${compiled.stderr}`);

  const launchers = [];
  const helpers = [];

  const launch = (args) => {
    const handle = startLauncher(["--rootfs", rootfs, ...args, "--", "true"], { HIVE_LIBKRUN: fakeSo });
    launchers.push(handle);
    return handle;
  };

  try {
    await t.test("--timeout stops the VM with exit 124", async () => {
      const handle = launch(["--timeout", "1"]);
      const result = await waitForExit(handle.exited, 10_000, "the launcher to time out");
      assert.equal(result.code, 124, `expected exit 124, got ${result.code}; stderr: ${handle.stderr}`);
      assert.match(handle.stderr, /timed out after 1 s/);
    });

    await t.test("--watch-pid stops the VM when its owner is gone, with exit 125", async () => {
      // A short-lived process that plays the owner: start it, let the launcher see it alive, kill it.
      const owner = spawn("sleep", ["60"], { stdio: "ignore" });
      helpers.push(owner);
      const ownerExited = new Promise((resolve) => owner.on("exit", resolve));
      const handle = launch(["--watch-pid", String(owner.pid)]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      owner.kill("SIGKILL");
      // Reap the owner first: kill(pid, 0) only reports ESRCH once it is no longer a zombie.
      await ownerExited;
      const result = await waitForExit(handle.exited, 10_000, "the launcher to notice the owner is gone");
      assert.equal(result.code, 125, `expected exit 125, got ${result.code}; stderr: ${handle.stderr}`);
      assert.match(handle.stderr, /owner process/);
    });

    await t.test("SIGTERM is still forwarded to the VM", async () => {
      const handle = launch([]);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      handle.child.kill("SIGTERM");
      const result = await waitForExit(handle.exited, 10_000, "the launcher to exit after SIGTERM");
      assert.notEqual(result.code, null, "the launcher should exit after SIGTERM");
      assert.equal(result.code, 143, `expected the child's SIGTERM exit (143), got ${result.code}`);
    });
  } finally {
    for (const handle of launchers) killGroup(handle.child.pid);
    for (const helper of helpers) {
      try {
        helper.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    await Promise.all(launchers.map((handle) => waitForExit(handle.exited, 5000, "cleanup").catch(() => {})));
    rmSync(base, { recursive: true, force: true });
  }
});
