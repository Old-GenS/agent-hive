## Goal

Let a server run start a brand-new project: the user picks **New project** in the web UI's New
run form and gives a name; the agent builds the project in an empty git repo inside the microVM;
when the run finishes with commits, the host creates a GitHub repository with `gh` under the
logged-in account and pushes the agent's commits to its `main` branch. No commits means no
repository is created.

## Files to touch

- `src/git.ts`
- `src/tasks.ts`
- `src/routes/sessions.ts`
- `ui/src/main.ts`
- `ui/src/app.css`
- `scripts/ui-smoke.mjs`
- `test/newrepo.test.mjs` (new)
- `README.md`
- `AGENTS.md`
- `.handoff/report.md`
- `.handoff/ui-*.png` (screenshots written by the smoke script)

## Steps

1. Run `npm ci`, then `cd ui && npm ci && cd ..`, then `bash vm/build.sh`.

2. `src/git.ts`: add and export

   ```ts
   export function validateRepoName(name: string): string
   export async function prepareNewRepo(dir: string): Promise<string>
   export async function githubLogin(): Promise<string>
   export async function createGithubRepo(name: string, isPrivate: boolean): Promise<string>
   ```

   - `validateRepoName`: trims; must match `/^[A-Za-z0-9_.-]{1,100}$/`, must not start with `.`
     or `-`, must not end with `.git`, must not be `.` or `..`; otherwise throw
     `Error("Project name may only use letters, digits, '-', '_' and '.' (max 100)")`. Returns the
     trimmed name.
   - `prepareNewRepo(dir)`: `origin = join(dir, "origin")`, `work = join(dir, "work")`;
     `mkdirSync(origin, { recursive: true })`; `git(["init", "-q", "-b", "main"], origin)`;
     `git(["-c", "user.name=" + config.git.authorName, "-c", "user.email=" + config.git.authorEmail, "commit", "-q", "--allow-empty", "-m", "Initial commit"], origin)`;
     `base = git(["rev-parse", "HEAD"], origin)`; then exactly the same four work-copy steps as
     `prepareRepo` (clone `--no-hardlinks` origin → work, remove the `origin` remote in work, set
     `user.name` / `user.email` in work). Returns `base`.
   - `githubLogin()`: runs `execFileAsync(GH_BIN, ["api", "user", "--jq", ".login"], { env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, timeout: 30_000 })`
     with `const GH_BIN = process.env.GH_BIN || "gh"` (read at call time); returns the trimmed
     stdout; throws `Error("Couldn't read the GitHub login (gh auth status)")` if it fails or is
     empty or doesn't match `/^[A-Za-z0-9-]+$/`.
   - `createGithubRepo(name, isPrivate)`: validates `name`, gets `owner = await githubLogin()`,
     then runs `GH_BIN repo create <owner>/<name> --private|--public --description "Created by agent-hive"`
     (same env and a 60 s timeout, argument array, no shell). On failure throw
     `Error("Couldn't create the GitHub repository <owner>/<name>: <stderr trimmed, last 500 chars>")`.
     Returns `<owner>/<name>`.

3. `src/tasks.ts`:
   - `TaskOptions` gains `newRepo?: { name: string; private?: boolean }`. `Task` gains
     `newRepoName?: string`, `newRepoPrivate = true`, `createdRepo?: string`; `toJSON()` adds
     `newRepo: this.newRepoName, createdRepo: this.createdRepo`.
   - `createTask`: if both `opts.repo` and `opts.newRepo` are set, throw
     `Error("Use repo or newRepo, not both")`. If `opts.newRepo` is set:
     `task.newRepoName = validateRepoName(opts.newRepo.name)`,
     `task.newRepoPrivate = opts.newRepo.private !== false`.
   - In `runPrompt`, preparation: when `task.newRepoName` is set (and not prepared), call
     `task.setStatus("cloning", { newProject: true })` and `task.baseSha = await prepareNewRepo(task.dir)`
     instead of `prepareRepo`.
   - The intro text: when `task.newRepoName` is set use
     `"/work is an empty git repository for a new project. Create the project there and commit your work with clear messages. You cannot push; when you finish, the server creates the GitHub repository " + task.newRepoName + " and pushes your commits to it.\n\n"`.
   - Review cycles and the `pushing` step run when `(task.repoUrl || task.newRepoName) && task.baseSha`.
   - `exportAndPush()`: after the export sandbox succeeds, if `this.newRepoName` is set:
     - count the `.patch` files in `out/`; if 0, set `commitsPushed = 0` and return (no repo
       created);
     - if `this.createdRepo` is not set yet: `this.createdRepo = await createGithubRepo(this.newRepoName, this.newRepoPrivate)`,
       then `this.repoUrl = normalizeRepo(this.createdRepo).url` and
       `git(["remote", "add", "origin", this.repoUrl], join(this.dir, "origin"))`;
     - `this.commitsPushed = await applyAndPush(this.dir, this.baseSha!, "main")` (force push: the
       repo was created by this task, and a follow-up rewrites `main` with the full history);
       `this.resultBranch = "main"`; return.
     Otherwise keep the existing behaviour unchanged.
   - Both `hive_done` events add `createdRepo: task.createdRepo`.

4. `src/routes/sessions.ts`: add to `promptSchema.body.properties`:
   `newRepo: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 100 }, private: { type: "boolean" } } }`;
   pass `newRepo: body.newRepo` to `createTask`; add `newRepo: task.newRepoName` to the new-task
   response.

5. `ui/src/main.ts` and `ui/src/app.css`, New run form:
   - Above Repository, a radio group `<fieldset>` with legend "Project" and two options:
     `#mode-existing` "Existing repo" (checked by default) and `#mode-new` "New project", styled as
     a two-button segmented control (each option at least 44 px tall, visible focus, the selected
     one with `--accent-soft` background and `--accent` border).
   - Existing repo: shows the current Repository, Branch and Review fields unchanged.
   - New project: hides Repository and Branch, shows `#newRepoName` (label "Project name",
     placeholder `my-new-project`) and a checkbox `#newRepoPrivate` "Private repository" (checked),
     with the hint "When the run finishes, hive creates the repository on GitHub under your
     account and pushes the agent's work to main." Review stays visible.
   - Validate the name client-side with the same rule as `validateRepoName`; show an inline error
     and keep Start run disabled while invalid or empty.
   - The POST body for a new project sends `newRepo: { name, private }` and never `repo` or
     `branch`; `reviewCycles` is sent when > 0.
   - Run view meta line: `new project <name>` in place of the repo name.
   - `hive_status` `cloning` with `newProject: true`: timeline text and bee label
     "Setting up the new project".
   - `hive_done` banner: when `createdRepo` is set, the detail is `Created <createdRepo> with N commit(s)`
     plus an `<a>` "Open on GitHub" with `href = "https://github.com/" + createdRepo`,
     `target="_blank"`, `rel="noopener noreferrer"` (only when `createdRepo` matches
     `/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/`); when a new project ended with no commits:
     `No changes, so no repository was created`. Build it with `el()` / `textContent`.

6. `scripts/ui-smoke.mjs`: keep every existing check and screenshot. After the existing run-view
   check returns to the form (after **New run**), add:
   - click `#mode-new`; assert `#repo` is hidden and `#newRepoName` is visible; fill
     `#newRepoName` with `bad name`, assert `#startBtn` is disabled; fill it with `demo-project`;
     fill `#task` with `new project task`; save `.handoff/ui-new-project.png`;
   - `await page.route("**/prompt", async (route) => { captured = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessionId: "demo-new", status: "queued", repo: null, newRepo: "demo-project", provider: "deepseek", model: "deepseek-v4-pro" }) }); });`
     and `await page.route("**/events/demo-new/ticket", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "demo" }) }));`
     (no WebSocket mock needed: a failed socket is fine here);
   - click `#startBtn`; wait for the run view; assert `captured.newRepo` deep-equals
     `{ name: "demo-project", private: true }`, `captured.repo === undefined`,
     `captured.branch === undefined`; assert the meta line contains `new project demo-project`;
   - unroute both, click **New run**, wait for `#provider`, then continue with the existing
     Settings checks.

7. `test/newrepo.test.mjs` (new), `node:test` style. Before importing from `dist/`: set
   `HIVE_DOTENV_PATH` to a missing file, `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL`
   to `t` / `t@t`, delete `HIVE_GIT_PROTOCOL`, and set `GH_BIN` to a fake script written into a
   `mkdtempSync(join(tmpdir(), "hive-newrepo-"))` dir (mode 0o755):

   ```sh
   #!/bin/sh
   printf '%s\n' "$*" >> "$FAKE_GH_LOG"
   if [ "$1" = api ]; then echo me; exit 0; fi
   if [ "$1" = repo ] && [ "$3" = me/taken ]; then echo "name already exists" >&2; exit 1; fi
   if [ "$1" = repo ]; then echo "https://github.com/$3"; exit 0; fi
   exit 1
   ```

   with `FAKE_GH_LOG` set to a file in the same dir. Tests:
   - `validateRepoName` accepts `my-app`, `a.b_c`; rejects `bad name`, `-x`, `.x`, `x.git`, `..`,
     `a/b`, a 101-char name.
   - `prepareNewRepo(dir)` creates `origin/` and `work/`; `git -C work log --format=%s` prints
     `Initial commit`; `git -C work remote` prints nothing; the returned base equals
     `git -C origin rev-parse HEAD`.
   - `createGithubRepo("demo", true)` returns `me/demo` and the log's last line is
     `repo create me/demo --private --description Created by agent-hive`;
     with `false` the line has `--public`.
   - `createGithubRepo("taken", true)` rejects with `/Couldn't create the GitHub repository me\/taken: name already exists/`.
   - `createTask({ prompt: "x", repo: "a/b", newRepo: { name: "c" } })` throws `/repo or newRepo/`
     (set `DEEPSEEK_API_KEY=sk-test` before importing so a provider resolves; import `createTask`
     from `../dist/tasks.js`; call `destroyTask(task.id)` on any task that does get created).

8. `README.md`: in the web UI section, one paragraph on **New project** (what it does, that it
   creates the repo under the `gh` account, private by default, pushes to `main`, nothing created
   without commits); in the API table's `/prompt` row add `newRepo` (`{name, private}`) to the
   listed fields.

9. `AGENTS.md`: under "GitHub access (server)", add a bullet: **New projects:** a task with
   `newRepo` starts from an empty repo; when the agent has commits, the host runs
   `gh repo create <login>/<name>` (private by default) and pushes to `main`. Needs a `gh` login
   that may create repos.

## Acceptance

- `npm test` exits 0 and includes the tests from `test/newrepo.test.mjs` passing.
- `npm run build:ui` exits 0.
- `npm i --no-save playwright-core@1.49.1 && node scripts/ui-smoke.mjs` prints `ui-smoke: ok`
  and exits 0, and `.handoff/ui-new-project.png` exists.
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies (`npm ci`, `npm i --no-save`) and
  temporary files outside the repo are fine.
- The only checks to run are the **Acceptance** commands. Don't write or run other end-to-end
  tests; never call the real `gh`, never create a real GitHub repository, never let a script reach
  the real `/prompt` endpoint. If something outside Acceptance fails, note it in the report and
  finish.
- Run `gh` and `git` only with argument arrays (no shell). Every API route stays in the
  authenticated scope; agent and GitHub data in the UI is rendered as text only.
- The host never runs git in `work/` after the agent has started (the `prepareNewRepo` setup
  happens before the sandbox runs, like `prepareRepo`).
- No new dependencies, no emoji in the UI.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- A Files tab or zip download, the CLI (`hive run`), creating repos under an organisation,
  choosing the default branch name, the Settings page.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
