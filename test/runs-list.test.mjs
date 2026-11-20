// The run list: every non-ephemeral task, newest first, with a one-line title. The env points at
// temp paths before anything from dist/ is imported, so no real keys file or workspace is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hive-runs-list-"));
process.env.HIVE_DOTENV_PATH = join(dir, "missing.env");
process.env.HIVE_KEYS_FILE = join(dir, "missing-keys");
process.env.WORKSPACE = join(dir, "workspace");
process.env.DEEPSEEK_API_KEY = "sk-test";

const { createTask, listTasks, destroyTask } = await import("../dist/tasks.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("listTasks returns non-ephemeral tasks newest first with one-line titles", async () => {
  const longLine = "x".repeat(200);
  const created = [];
  try {
    // Created oldest first; the list should come back in the reverse order.
    created.push(createTask({ prompt: `${longLine}\nmore`, provider: "deepseek" }).id);
    await sleep(5);
    const newest = createTask({ prompt: "First line\nmore", provider: "deepseek" });
    created.push(newest.id);
    await sleep(5);
    created.push(createTask({ prompt: "Throwaway", provider: "deepseek", ephemeral: true }).id);

    const tasks = listTasks();
    assert.equal(tasks.length, 2, "ephemeral tasks are left out");
    assert.deepEqual(
      tasks.map((task) => task.title),
      ["First line", `${longLine.slice(0, 120)}\u2026`],
    );
    assert.equal(tasks[0].sessionId, newest.id);
    assert.equal(tasks[0].title, "First line");
    assert.equal(tasks[1].title.length, 121);
    assert.ok(tasks[1].title.endsWith("\u2026"));
  } finally {
    for (const id of created) destroyTask(id);
  }
});
