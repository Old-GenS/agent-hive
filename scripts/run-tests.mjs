// Runs the test suite with TMPDIR pointing at a fresh folder and deletes that folder afterwards,
// pass or fail, so test runs leave nothing behind in /tmp. Every test makes its temp dirs with
// os.tmpdir(), which follows TMPDIR, and so do the git and node processes the tests start.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hive-tests-"));
const cleanup = () => rmSync(root, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

let status = 1;
try {
  const result = spawnSync(process.execPath, ["--test", "test/*.test.mjs", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: root },
  });
  status = result.status ?? 1;
} finally {
  cleanup();
}
process.exit(status);
