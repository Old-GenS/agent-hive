## Goal

Add a `hive` command-line tool to agent-hive that runs a coding agent on the current local git
repo inside a throwaway libkrun microVM, the same way pi-vm and dsh-vm work:

- `hive run "<prompt>"` clones the current repo with `--no-hardlinks` into a run dir, boots a VM
  with the existing launcher (`runSandbox()` in `src/sandbox.ts`, libkrun backend), passes the
  prompt as a file, shows the agent's progress live by following a JSONL log file that pi writes
  inside the VM, then exports the agent's commits as patch files.
- `hive log`, `hive diff`, `hive apply`, `hive list`, `hive clean` manage runs.
- Text moves between host and VM only through files in shared folders. Never parse the VM's
  stdout.

The server code (`src/index.ts`, `src/auth.ts`, `src/routes/`, `src/tasks.ts`, `ui/`) stays
exactly as it is.

## Files to touch

- `src/cli.ts` (new)
- `src/runs.ts` (new)
- `src/follow.ts` (new)
- `src/render.ts` (new)
- `src/config.ts`
- `src/git.ts`
- `package.json`
- `README.md`
- `AGENTS.md`
- `test/cli.test.mjs` (new)
- `.handoff/report.md`

## Steps

1. Run `npm ci`.

2. `src/config.ts`:
   - Replace `dotenv.config();` with
     `dotenv.config(process.env.HIVE_DOTENV_PATH ? { path: process.env.HIVE_DOTENV_PATH } : undefined);`
   - Add to the `config` object: `runsDir: resolve(process.env.HIVE_RUNS_DIR || join(cacheHome, "agent-hive/runs")),`

3. `src/git.ts`, add these exports (all use the existing `git()` helper):
   - `repoTop(cwd: string): Promise<string>`: `git rev-parse --show-toplevel` in `cwd`. Throws
     `Error("not in a git repo")` on failure.
   - `isDirty(repo: string): Promise<boolean>`: true when `git status --porcelain` in `repo` prints
     anything.
   - `prepareLocal(repo: string, work: string): Promise<string>`: `base = git rev-parse HEAD` in
     `repo`; `git clone -q --no-hardlinks -- <repo> <work>`; in `work`: `git remote remove origin`,
     `git config user.name <config.git.authorName>`, `git config user.email <config.git.authorEmail>`.
     Returns `base`.
   - `gitIdentity(): Record<string, string>`: the same four `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
     entries as the private `gitIdentity()` in `src/tasks.ts` (leave that one in place).

4. `src/follow.ts`, export
   `followJsonl(path: string, onEvent: (event: any) => void, intervalMs = 250): { poll(): void; stop(): void }`:
   - Keeps a byte offset into the file. `poll()` opens the file and reads every byte after the
     offset with `fs.openSync` / `fs.readSync`, then closes it. A missing file is a no-op.
   - Splits on byte 10 (LF) only. Keeps an incomplete last line in a buffer until its LF arrives.
     Strips a trailing `\r`. Calls `onEvent(JSON.parse(line))` for each non-empty line and skips
     lines that don't parse. An exception thrown by `onEvent` is caught and printed with
     `console.error`.
   - Starts a `setInterval(poll, intervalMs)`. `stop()` clears the interval and calls `poll()` one
     last time.
   - Polling only, no `fs.watch`. The file sits on a virtiofs share.

5. `src/render.ts`, export:
   - `renderEvent(e: any): string | undefined`:
     - `e.type === "message_end"` and `e.message.role === "assistant"`: join the `text` of the
       content blocks whose `type === "text"`. If `e.message.errorMessage` is set, return
       `"error: " + errorMessage`. Otherwise return the joined text, or `undefined` when it is empty.
     - `e.type === "tool_execution_start"`: return `"  → " + e.toolName + " " + summary`, where
       `summary` is `e.args.command` for `bash`, `e.args.path` for `read`, `edit` and `write`, and
       `JSON.stringify(e.args)` for anything else. Collapse whitespace runs to one space and trim.
       If `summary` is longer than 100 characters, cut it to 99 and append `…`.
     - `e.type === "tool_execution_end"` and `e.isError === true`: return `"  ✗ " + e.toolName + " failed"`.
     - Anything else: `undefined`.
   - `type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }`
     and `emptyUsage(): Usage`.
   - `addUsage(total: Usage, e: any): void`: for `message_end` with an assistant message, add
     `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite` and `usage.cost.total`,
     treating missing numbers as 0 (same fields as `runAgent` in `src/tasks.ts`).
   - No ANSI colours anywhere.

6. `src/runs.ts`:
   - Run dir: `<config.runsDir>/<basename of repo>-<YYYYMMDD-HHMMSS>` in local time. If it exists,
     append `-2`, `-3` and so on. Subfolders:
     - `work/`: the agent's copy, mounted at `/work`
     - `io/`: mounted at `/io`; holds `prompt.md`, `system.md`, `events.jsonl`, `stderr.log`
     - `session/`: pi's session, mounted at `/session`
     - `out/`: patches, mounted at `/out` by the export step only
   - `meta.json`:
     `{ repo, base, provider, model, thinking, prompt (first 200 chars), status ("running" | "done" | "failed" | "aborted"), pid, commits, usage, error?, createdAt, finishedAt? }`.
     Write it atomically (write `meta.json.tmp`, then `renameSync`).
   - `export interface RunMeta` with those fields; `readMeta(dir)`, `writeMeta(dir, meta)`.
   - `isLive(meta)`: `status === "running"` and `process.kill(meta.pid, 0)` doesn't throw.
   - `resolveRun(arg?: string): string`:
     - With no `arg`, return the run with the newest `createdAt`, or throw `Error("no runs")`.
     - Otherwise treat `arg` as a name under `config.runsDir` if it has no `/`, or as a path if it
       does. Its `realpathSync` must have a `dirname` equal to `realpathSync(config.runsDir)` and
       contain `meta.json`, or throw `Error("not a run: " + arg)`.
   - `listRuns(): { name: string; dir: string; meta: RunMeta }[]`, newest first. Skip dirs without a
     readable `meta.json`. Return `[]` when `config.runsDir` doesn't exist.
   - `cleanRun(dir)`: throw `Error("run is still going: <name>")` if `isLive`; otherwise
     `rmSync(dir, { recursive: true, force: true })`.
   - `startRun(o: { repo: string; prompt: string; provider?: string; model?: string; thinking?: string; onEvent: (e: any) => void; signal: AbortSignal }): Promise<{ dir: string; meta: RunMeta }>`.
     It throws only on errors before the VM starts. After that it records the outcome in `meta.json`
     and returns:
     1. Resolve the provider, key, model and thinking level the same way `createTask` in
        `src/tasks.ts` does, using `resolveProvider`, `providerKey`, `PROVIDERS`,
        `config.defaultModel` and `config.defaultThinking`, with the same error messages. Valid
        thinking levels: `off minimal low medium high xhigh`.
     2. Create the run dir and its four subfolders. `base = await prepareLocal(repo, <dir>/work)`.
        Write `io/prompt.md` (the prompt) and `io/system.md` (`config.systemPrompt`). Write
        `meta.json` with `status: "running"`, `pid: process.pid`, `commits: 0` and `emptyUsage()`.
     3. `mounts`: `work`→`/work`, `io`→`/io`, `session`→`/session`. Add the npm cache exactly as
        `runAgent` in `src/tasks.ts` does (`mkdirSync`, then `shared: true`, at `/root/.npm`) when
        `config.sandbox.npmCache` is non-empty.
     4. Call `runSandbox({ name: "hive-" + <run dir basename>, mounts, env: { [PROVIDERS[provider].sandboxEnv]: key, ...gitIdentity() }, command })`
        with no `onEvent`, where `command` is:
        `["bash", "-c", 'exec hive-agent "$@" > /io/events.jsonl 2> /io/stderr.log', "hive-agent", "-p", "--provider", provider, "--model", model, "--thinking", thinking, "--session-dir", "/session", "--append-system-prompt", "/io/system.md", "@/io/prompt.md", "Do the task described in the attached file prompt.md."]`
     5. `followJsonl(<dir>/io/events.jsonl, e => { addUsage(meta.usage, e); o.onEvent(e); })`.
        When `o.signal` fires, call the handle's `stop()`.
     6. `await handle.done`, then call the follower's `stop()`. Set the outcome:
        - signal aborted → `"aborted"`
        - `timedOut` → `"failed"` with error `timed out after <config.sandbox.timeoutMin> minutes`
        - `code !== 0` → `"failed"` with error `agent exited <code>: ` plus the last 2000 characters
          of `io/stderr.log` (or of the handle's `stderr` when that file is missing or empty)
     7. When `code === 0` and not aborted: `runSandbox({ name: "hive-" + <basename> + "-export", mounts: [work→/work, out→/out], env: gitIdentity(), command: ["hive-export", base] })`.
        A non-zero exit → `"failed"` with error `export failed (exit <code>)`. Otherwise
        `commits` = the number of `*.patch` files in `out/` and status `"done"`.
     8. Set `finishedAt`, write `meta.json`, return `{ dir, meta }`.
   - `patchFiles(dir): string[]`: absolute paths of `out/*.patch`, sorted.
   - `diffRun(dir: string, stat: boolean): Promise<string>`: `""` when there are no patches. With
     `stat`, the stdout of `git apply --stat <patches…>` run with `cwd: dir`. Otherwise the patch
     files' contents joined in order.
   - `applyRun(dir: string, repo: string, branch?: string): Promise<string>`:
     - `meta.status` must be `"done"` (else throw `run is <status>; nothing to apply`) and
       `commits > 0` (else throw `nothing to apply`).
     - `realpathSync(repo)` must equal `realpathSync(meta.repo)` (else throw
       `this run belongs to <meta.repo>`).
     - `isDirty(repo)` → throw `repo has uncommitted changes; commit or stash first`.
     - Without `branch`: `git rev-parse HEAD` in `repo` must equal `meta.base` (else throw
       `repo HEAD moved since the run; use --branch`). Run `git apply <all patches in one call>` in
       `repo`. Return the output of `git status --short`.
     - With `branch`: `validateBranch(branch)`. If `git rev-parse --verify --quiet refs/heads/<branch>`
       succeeds, throw `branch <branch> already exists`. Run `git switch -q -c <branch> <meta.base>`,
       then `git am -q --keep-cr <patches…>`. If `git am` fails, run `git am --abort` and rethrow.
       Return `on branch <branch>: <commits> commit(s)`.

7. `src/cli.ts`:
   - First line `#!/usr/bin/env node`.
   - Before importing anything from `./config.js`, `./sandbox.js`, `./runs.js` or `./git.js`
     (import them with `await import(...)` inside `main()`):
     - set `process.env.HIVE_DOTENV_PATH` to `<XDG_CONFIG_HOME or ~/.config>/agent-hive/env` if unset;
     - if `HIVE_RUNTIME` is set to anything other than `libkrun`, print
       `hive: the CLI only supports HIVE_RUNTIME=libkrun` and exit 1; otherwise set it to `libkrun`.
   - Parse arguments with `parseArgs` from `node:util`. Usage text, printed by `--help`, `-h` or no
     arguments (exit 0), and on stderr for an unknown command (exit 1):
     ```
     hive run [-m model] [-p provider] [-t thinking] [--json] "<prompt>"
     hive run [-m model] [-p provider] [-t thinking] [--json] -f <prompt-file>
     hive log [run] [--json]
     hive diff [run] [--stat]
     hive apply [run] [--branch <name>]
     hive list
     hive clean <run> | --all
     ```
     `[run]` defaults to the newest run.
   - `run`:
     1. `repo = repoTop(process.cwd())`. The prompt comes from the positional argument, or
        `readFileSync(-f)`. A missing or empty prompt is an error.
     2. If `libkrunAvailable()` is false, print `hive: can't start a VM:` followed by each line of
        `checkSandbox()` and the line `hive needs /dev/kvm, pasta, libkrun, the launcher (npm run build:vm) and the rootfs (npm run build:rootfs)`, then exit 1.
     3. If `isDirty(repo)`, print to stderr
        `hive: uncommitted changes are not included; the agent works on HEAD`.
     4. `AbortController`. The first SIGINT prints `hive: stopping…` and aborts; a second SIGINT
        exits 130 at once.
     5. `startRun`. Print `hive: run <name>` on stderr once the run dir exists (pass a callback or
        print after `listRuns()`; either is fine). `onEvent`: with `--json` write
        `JSON.stringify(e)` plus a newline to stdout; otherwise write `renderEvent(e)` plus a
        newline when it returns a string.
     6. At the end, print to stderr:
        - `done`: `hive: done, <commits> commit(s), $<cost.toFixed(4)>, <input> in / <output> out tokens`,
          then `hive diff <name>` and `hive apply <name>` on two lines. Exit 0.
        - `failed`: `hive: failed: <error>`. Exit 1.
        - `aborted`: `hive: aborted`. Exit 130.
   - `log`: `resolveRun`. Follow `io/events.jsonl` from the start with the same rendering (`--json`
     prints raw lines). If the run isn't live, `poll()` once, `stop()`, and print the status line.
     Otherwise check `meta.json` every 500 ms until the run isn't live, then `stop()` and print
     `hive: <status>`.
   - `diff`: print `diffRun(dir, stat)`, or `hive: no changes` on stderr when it is empty.
   - `apply`: `applyRun(resolveRun(arg), await repoTop(process.cwd()), branch)` and print the result.
   - `list`: one line per run, `<name>  <status>  <commits> commit(s)  $<cost.toFixed(4)>  <repo>`,
     or `no runs`.
   - `clean`: `clean <run>` → `cleanRun`. `clean --all` → `cleanRun` every run that isn't live and
     print `hive: kept <name> (still running)` for each live one.
   - Wrap `main()` so that any thrown `Error` prints `hive: <message>` on stderr and exits 1.

8. `package.json`: add `"bin": { "hive": "dist/cli.js" }`. Change no existing script or dependency.

9. `README.md`: add a section `## Command line (hive)` near the top, covering:
   - setup: `npm ci && npm run build && npm run build:image && npm run build:vm && npm run build:rootfs && npm link`
   - keys go in `~/.config/agent-hive/env` (for example `OPENROUTER_API_KEY=...`)
   - each command with a one-line description
   - the run dir layout
   
   `AGENTS.md`: add rows for `src/cli.ts`, `src/runs.ts`, `src/follow.ts` and `src/render.ts` to the
   Layout table. Under the security model, add: "The CLI's host git runs only in the user's repo
   (rev-parse, status, clone source, apply/am of exported patches), never in a run's `work/`. Text
   crosses into and out of the VM only as files in `io/` and patches in `out/`."

10. `test/cli.test.mjs` (`node:test` and `node:assert/strict`; import from `../dist/…` with
    `await import` after setting `process.env.HIVE_RUNS_DIR` to a fresh `mkdtempSync` dir at the top
    of the file):
    - `followJsonl`: write `{"a":1}\n{"b"` to a temp file → `poll()` gives 1 event. Append `:2}\n`
      → 2 events, the second `{ b: 2 }`. Append `garbage\n` → still 2. Then `stop()`.
    - `renderEvent`:
      - `{type:"tool_execution_start",toolName:"bash",args:{command:"npm   test"}}` → `"  → bash npm test"`
      - `read` with `args.path:"a.txt"` → `"  → read a.txt"`
      - a 300-character bash command → length ≤ 109 and ends with `…`
      - an assistant `message_end` with content `[{type:"thinking",thinking:"x"},{type:"text",text:"hi"}]` → `"hi"`
      - a `user` `message_end` → `undefined`
      - `{type:"tool_execution_end",toolName:"bash",isError:true}` → `"  ✗ bash failed"`
    - `addUsage`: two assistant `message_end` events with
      `usage:{input:10,output:5,cacheRead:1,cacheWrite:2,cost:{total:0.5}}` → totals
      `20/10/2/4/1`.
    - `resolveRun`:
      - creates `<runsDir>/r1` and `<runsDir>/r2` with `meta.json` (`createdAt` 1 and 2)
      - `resolveRun("r1")` ends with `/r1`
      - `resolveRun()` ends with `/r2`
      - `resolveRun("/etc")` and `resolveRun("../x")` throw
    - `applyRun`, all with `git -c user.name=t -c user.email=t@t`:
      - make a temp repo with one commit holding `f.txt`
      - clone it to a temp dir, change `f.txt`, add `new.txt`, commit `"agent change"`
      - `git format-patch -o <runsDir>/r3/out <base>..HEAD`
      - write `<runsDir>/r3/meta.json` with `status:"done"`, `commits:1`, `repo`, `base`, `createdAt:3`
      - `applyRun(r3, repo)`: HEAD is unchanged, `git status --porcelain` shows ` M f.txt` and
        `?? new.txt`, and a second `applyRun` throws `/uncommitted/`
      - `git checkout -- . && git clean -fdq`, then `applyRun(r3, repo, "hive/t")`: the current
        branch is `hive/t` and `git log -1 --format=%s` is `agent change`
    - CLI, via `execFileSync(process.execPath, ["dist/cli.js", ...])` with `cwd` the agent-hive repo:
      - `--help` exits 0, and its output contains `hive run`, `hive log`, `hive diff`, `hive apply`,
        `hive list` and `hive clean`
      - `list` with `HIVE_RUNS_DIR` set to a new empty temp dir prints `no runs`
      - `bogus` exits 1

## Acceptance

1. `npm ci` exits 0.
2. `npm run build` exits 0.
3. `npm test` exits 0, and its output shows the new tests from `test/cli.test.mjs` passing, with `fail 0`.
4. `node dist/cli.js --help` exits 0 and prints lines starting with `hive run`, `hive log`, `hive diff`, `hive apply`, `hive list` and `hive clean`.
5. `HIVE_RUNS_DIR=$(mktemp -d) node dist/cli.js list` prints `no runs`.
6. `head -1 dist/cli.js` prints `#!/usr/bin/env node`.
7. `git diff --quiet HEAD -- src/index.ts src/auth.ts src/routes src/tasks.ts src/sandbox.ts ui image vm` exits 0.
8. `R=$PWD; T=$(mktemp -d); cd $T && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x && node $R/dist/cli.js run "hi"; echo "exit=$?"; cd $R` prints `exit=1`, and stderr contains `hive: can't start a VM:` (this machine has no /dev/kvm).
9. `grep -c '"hive": "dist/cli.js"' package.json` prints `1`.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches. Do not touch files outside **Files to touch** except
  `.handoff/report.md`. Installing dependencies and temporary files outside the repo are fine.
- No new npm dependencies.
- Don't change `src/sandbox.ts`, `src/tasks.ts`, `src/index.ts`, `src/auth.ts`, `src/routes/`,
  `ui/`, `image/` or `vm/`.
- The CLI never calls podman, and never reads events from the VM's stdout. Events come only from
  `io/events.jsonl`.
- The host never runs git inside a run's `work/` after `prepareLocal` returns.
- API keys go to `runSandbox` only through its `env` object, never in `command` or in any file.
- Strict TypeScript (the existing `tsconfig.json`), ES modules, Node 24 built-ins only.

## Out of scope

`hive serve`, `hive mcp`, review cycles, follow-up prompts on an existing run, macOS support,
pushing to GitHub, a desktop app, and any change to the server, the web UI, the image or the
launcher.

## If blocked

If a step is wrong or impossible as written, stop. Write what blocked you and where in
`.handoff/report.md`, and don't improvise around it.
