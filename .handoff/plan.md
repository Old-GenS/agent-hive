## Goal

Extend the `hive` CLI (`src/cli.ts`, `src/runs.ts`) with git-host support, with nothing tied to any
particular user or account:

- `hive run --repo <ref> [--ref <branch>] "<prompt>"` runs on a remote repo without a local checkout.
- `hive push [run] [--branch <name>] [--remote <name>] [--pr] [--base <branch>]` puts the run's
  patches on a new branch, pushes it with the user's own git credentials, and with `--pr` opens a
  GitHub pull request through the user's `gh`.
- Settings come from env vars, which can live in `~/.config/agent-hive/env`. The commit identity
  defaults to the user's own git identity.
- Remove the maintainer's personal accounts and domain from `AGENTS.md` and `public/landing.html`.

## Files to touch

- `src/cli.ts`
- `src/runs.ts`
- `src/git.ts`
- `src/config.ts`
- `README.md`
- `AGENTS.md`
- `public/landing.html`
- `test/push.test.mjs` (new)
- `.handoff/report.md`

## Steps

1. Run `npm ci`.

2. `src/config.ts`: in the `git` block, add `pushRemote: process.env.HIVE_PUSH_REMOTE || "origin",`.

3. `src/git.ts`:
   - Change `applyAndPush(dir, base, resultBranch)` to
     `applyAndPush(dir: string, base: string, resultBranch: string, force = true)`. When `force` is
     false, the push command has no `--force`. Everything else stays the same, and the existing
     caller in `src/tasks.ts` keeps working unchanged.
   - Add `normalizeCliRepo(input: string): { url: string; name: string }`:
     - trim `input`
     - `owner/name` (the existing `OWNER_REPO` regex) → url `https://github.com/<owner>/<name>.git`,
       name `<name>`
     - starts with `https://`, `http://`, `ssh://`, or matches `/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/`
       → url as given, with trailing `/` removed
     - name: the last path segment, split on `/` and `:`, with a trailing `.git` removed. Empty →
       `"repo"`
     - anything else, including strings starting with `-` → throw
       `Error("repo must be owner/name or a git URL")`
   - Add `githubSlug(url: string): string | undefined`. It returns `owner/name`, without `.git`, for
     `https://github.com/owner/name(.git)(/)`, `ssh://git@github.com/owner/name(.git)` and
     `git@github.com:owner/name(.git)`. Anything else returns `undefined`.
   - Add `gitConfigIdentity(cwd: string): { name?: string; email?: string }`. It uses
     `execFileSync("git", ["config", "--get", "user.name"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })`,
     and the same for `user.email`. Trim each value. A failing command or empty output leaves that
     field undefined.

4. `src/runs.ts`:
   - `RunMeta` gains:
     - `source: "local" | "remote"`
     - `summary?: string`
     - `pushed?: { branch: string; url: string; at: number }`
     - `prUrl?: string`
     
     For remote runs, `repo` holds the remote URL.
   - `StartRunOptions`: `repo` becomes optional, and `remote?: { url: string; name: string; ref?: string }`
     is added. Exactly one of the two must be given (else throw `Error("startRun needs repo or remote")`).
   - `startRun`:
     - Local runs behave exactly as now, with `source: "local"`.
     - Remote runs: the run dir name uses `remote.name` in place of `basename(repo)`. Instead of
       `prepareLocal`, run `base = await prepareRepo(dir, remote.url, remote.ref)` (the existing
       function: it clones into `<dir>/origin` and `<dir>/work`). Then `meta.repo = remote.url` and
       `source: "remote"`.
     - In the follower callback, when `e.type === "message_end"` and `e.message.role === "assistant"`,
       save the joined text of its `type === "text"` blocks, if non-empty, as the latest summary.
     - When writing the final `meta.json`, set `meta.summary` to the latest summary, cut to 60000
       characters, when there is one.
   - `applyRun`: right after reading `meta`, if `meta.source === "remote"`, throw
     `Error("this run is from " + meta.repo + "; use hive push")`. Treat a missing `source` as
     `"local"`.
   - Add `pushRun(dir: string, o: { branch?: string; remote?: string } = {}): Promise<{ branch: string; url: string; commits: number }>`:
     1. Read `meta`. `status` must be `"done"` (else throw `run is <status>; nothing to push`) and
        `commits > 0` (else throw `nothing to push`).
     2. `branch = validateBranch(o.branch ?? config.git.branchPrefix + basename(dir))`.
     3. Remote runs: `url = await git(["remote", "get-url", "origin"], join(dir, "origin"))`.
     4. Local runs:
        - `remoteName = o.remote ?? config.git.pushRemote`.
        - `url = await git(["remote", "get-url", "--push", remoteName], meta.repo)`. On failure
          throw `repo <meta.repo> has no remote "<remoteName>"`.
        - `rmSync(join(dir, "origin"), { recursive: true, force: true })`.
        - `git clone -q --no-hardlinks -- <meta.repo> <dir>/origin`.
        - In `<dir>/origin`: `git remote set-url origin <url>`.
        - In `<dir>/origin`: `git cat-file -e <meta.base>^{commit}`. On failure throw
          `the run's base commit is no longer in <meta.repo>`.
     5. `commits = await applyAndPush(dir, meta.base, branch, false)`. If it throws, rethrow
        `Error(<its message> + " (check your git credentials for " + url + ")")`.
     6. `meta.pushed = { branch, url, at: Date.now() }`. `writeMeta`. Return `{ branch, url, commits }`.
   - Add `patchSubject(patchText: string): string`. It takes the first line starting with
     `Subject: `, removes `Subject: ` and a leading `[PATCH...] ` group (regex `/^\[PATCH[^\]]*\]\s*/`),
     and trims. Returns `""` when there is no such line.
   - Add `prArgs(o: { slug: string; branch: string; title: string; body: string; base?: string }): string[]`.
     It returns `["pr", "create", "--repo", slug, "--head", branch, "--title", title, "--body", body]`,
     plus `["--base", base]` when `base` is set.
   - Add `openPr(dir: string, o: { base?: string } = {}): Promise<string>`:
     1. Read `meta`. If there is no `meta.pushed`, throw `push the run first`.
     2. `slug = githubSlug(meta.pushed.url)`. If undefined, throw
        `pull requests need a github.com remote (pushed to <url>)`.
     3. `title` = `patchSubject` of the first patch file. If empty, use `meta.prompt` cut to 70
        characters.
     4. `body` = `meta.summary` if set, else `title`.
     5. Run `execFile("gh", prArgs({ slug, branch: meta.pushed.branch, title, body, base: o.base }), { timeout: 120_000 })`
        via `promisify`. An `ENOENT` error → throw
        `gh is not installed; install the GitHub CLI and run gh auth login to open pull requests`.
        Any other error → throw `gh pr create failed: <stderr or message, trimmed>`.
     6. `prUrl` = the last non-empty line of stdout, trimmed. Save it to `meta.prUrl` and `writeMeta`.
        Return it.

5. `src/cli.ts`:
   - In `main()`, after the existing env setup and before the first dynamic import: if
     `process.env.GIT_AUTHOR_NAME` is unset, read `user.name` and `user.email` with a small local
     helper in `cli.ts` that does the same as `gitConfigIdentity` (`execFileSync("git", ["config", "--get", key], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })`,
     trimmed, with failures treated as unset). Don't import `./git.js` for this: `config.ts` reads
     the env when it is first imported, so the identity must be set before that. If both values are
     found, set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
     `GIT_COMMITTER_EMAIL` from them.
   - `run` gains the options `--repo` (string) and `--ref` (string):
     - With `--repo`: don't call `repoTop` and don't check for a dirty tree.
       `remote = { ...normalizeCliRepo(values.repo), ref: values.ref }`. Pass `remote` to `startRun`
       in place of `repo`. `--ref` without `--repo` is an error: `--ref needs --repo`.
     - Keep the order: parse the prompt, then resolve local or remote, then `libkrunAvailable()`, then
       `startRun`.
     - The final `done` lines print `hive push <name>` in place of `hive apply <name>` when the run
       is remote; local runs print both `hive apply <name>` and `hive push <name>`.
   - New command `push`: options `--branch` (string), `--remote` (string), `--pr` (boolean) and
     `--base` (string).
     - `dir = resolveRun(positionals[0])`, then `pushRun(dir, { branch, remote })`. Print
       `hive: pushed <commits> commit(s) to <branch> on <url>` to stdout.
     - With `--pr`: `openPr(dir, { base })` and print the URL on its own line.
     - `--base` without `--pr` is an error: `--base needs --pr`.
   - Usage text: add these lines after the `hive apply` line, and change both `hive run` lines to
     include `[--repo <owner/name|url> [--ref <branch>]]` after `[--json]`:
     ```
     hive push [run] [--branch <name>] [--remote <name>] [--pr [--base <branch>]]
     ```

6. `README.md`, in the `## Command line (hive)` section:
   - Document `--repo` and `--ref`, and `hive push` with `--branch`, `--remote`, `--pr` and `--base`.
   - Say that pushing uses the user's own git credentials (SSH key, credential helper, or `gh auth setup-git`), and `--pr` uses their `gh` login.
   - Add a settings table: `HIVE_RUNS_DIR`, `HIVE_BRANCH_PREFIX` (default `hive/`), `HIVE_PUSH_REMOTE`
     (default `origin`), `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` (default: your git `user.name` and
     `user.email`), `DEFAULT_PROVIDER`, `DEFAULT_MODEL`, the provider key variables from `PROVIDERS`,
     `HIVE_SANDBOX_MEMORY`, `HIVE_SANDBOX_CPUS` and `HIVE_SANDBOX_TIMEOUT_MIN`. Each row gets a
     one-line meaning, and the table says the variables can go in `~/.config/agent-hive/env`.

7. `AGENTS.md`:
   - Rename the section `## Two-account GitHub model` to `## GitHub access (server)`.
   - Replace `stansz` with `<owner>` and `oatclaw88` with `<bot>` everywhere in that section and in
     `### Commit author`, and drop the sentence about keeping the old attribution.
   - Add one line under the section: "The `hive` CLI needs none of this: it uses the user's own git
     credentials and `gh` login on the host; nothing is passed into the VM."
   - Keep the `hive-mcp` link on line 8 as it is.

8. `public/landing.html`: replace every `https://hive.ogsapps.cc` with `https://hive.example.com`.
   Keep the links to the project's GitHub repo.

9. `test/push.test.mjs` (`node:test` and `node:assert/strict`):
   - Set `process.env.HIVE_RUNS_DIR` to a fresh `mkdtempSync` dir, plus `GIT_AUTHOR_NAME`,
     `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` to `t` / `t@t`, before any
     `await import("../dist/…")`.
   - `normalizeCliRepo`:
     - `"a/b"` → `{ url: "https://github.com/a/b.git", name: "b" }`
     - `"https://gitlab.com/x/y.git/"` → url `https://gitlab.com/x/y.git`, name `y`
     - `"git@github.com:a/b.git"` → name `b`
     - `"-x"`, `"/tmp/repo"` and `"b"` throw
   - `githubSlug`:
     - the https, ssh:// and scp forms of `github.com/a/b(.git)` → `"a/b"`
     - `https://gitlab.com/a/b.git` → `undefined`
   - `patchSubject`: `"From x\nSubject: [PATCH 2/3] fix calc\n\n"` → `"fix calc"`; text with no
     subject → `""`.
   - `prArgs` with and without `base`: exact arrays.
   - `gitConfigIdentity`: in a temp repo with `git config user.name n` and `user.email e@e`, it
     returns `{ name: "n", email: "e@e" }`.
   - `pushRun` (local run):
     - Make a bare repo `remote.git`. Clone it to `local`, commit `f.txt` and push `main`. The bare
       repo also gets a remote named `upstream` (a second bare repo `up.git`) in `local`.
     - Clone `local` to a temp dir, change `f.txt`, commit `agent change`, and
       `git format-patch -o <runsDir>/r1/out <base>..HEAD`.
     - Write `<runsDir>/r1/meta.json`:
       `{ source:"local", status:"done", commits:1, repo:<local>, base:<base>, createdAt:1, prompt:"p", usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:0}, pid:1, provider:"x", model:"y", thinking:"low" }`
     - `pushRun(r1)`: returns `branch` `hive/r1` and `commits` 1, and
       `git --git-dir remote.git log -1 --format=%s hive/r1` prints `agent change`. `meta.json` now
       has `pushed.branch === "hive/r1"`.
     - `pushRun(r1, { branch: "feat/x", remote: "upstream" })` puts `feat/x` in `up.git` with the
       same subject.
     - `pushRun(r1, { branch: "bad..name" })` throws.
     - A run with `status:"failed"` throws `/nothing to push|failed/`.
   - `pushRun` (remote run): `prepareRepo(<runsDir>/r2, <path of remote.git>)` returns `base`.
     Create a commit in a separate clone of `remote.git` (not pushed), and `format-patch` it into
     `<runsDir>/r2/out`. Write meta with `source:"remote"`, `repo:<remote.git path>`, `base`,
     `status:"done"`, `commits:1`. `pushRun(r2)` puts `hive/r2` in `remote.git`.
   - `applyRun` on the remote run throws `/use hive push/`.
   - `openPr` on a run without `pushed` throws `/push the run first/`. A run whose `pushed.url` is
     `https://gitlab.com/a/b.git` throws `/github.com remote/`.

## Acceptance

1. `npm ci` exits 0.
2. `npm run build` exits 0.
3. `npm test` exits 0. Its output shows the tests from `test/push.test.mjs` passing and `fail 0`.
4. `node dist/cli.js --help` exits 0. Its output contains a line starting with `hive push` and the text `--repo`.
5. `git grep -n 'ogsapps' -- public src` exits 1 (no matches).
6. `git grep -nE 'oatclaw88|stansz' -- src AGENTS.md` prints only the `hive-mcp` link line in `AGENTS.md`.
7. `git diff --quiet HEAD -- src/index.ts src/auth.ts src/routes src/tasks.ts src/sandbox.ts ui image vm` exits 0.
8. `R=$PWD; T=$(mktemp -d); cd $T && node $R/dist/cli.js run --repo a/b "hi"; echo "exit=$?"; cd $R` prints `exit=1`. Stderr contains `hive: can't start a VM:` and does not contain `not in a git repo`.
9. `node dist/cli.js push nope; echo "exit=$?"` prints `exit=1`, and stderr contains `not a run`.
10. `node dist/cli.js run --ref main "hi"; echo "exit=$?"` (run from the repo root) prints `exit=1`, and stderr contains `--ref needs --repo`.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches. Do not touch files outside **Files to touch** except
  `.handoff/report.md`. Installing dependencies and temporary files outside the repo are fine.
- No new npm dependencies.
- Don't change `src/sandbox.ts`, `src/tasks.ts`, `src/index.ts`, `src/auth.ts`, `src/routes/`,
  `ui/`, `image/` or `vm/`.
- No user names, account names, domains or tokens in code or tests. Defaults come from env vars or
  the user's git config.
- Git credentials and the `gh` login are used only by host-side commands. Nothing new is mounted or
  passed into the VM.
- The host never runs git in a run's `work/` after it is cloned. Pushing uses `<dir>/origin` only.
- Pushes are never forced from the CLI.
- Strict TypeScript, ES modules, Node 24 built-ins only.

## Out of scope

Review cycles, forks and cross-repo PRs, PR updates, `hive serve`, `hive mcp`, macOS, and any change
to the server, the web UI, the image or the launcher.

## If blocked

If a step is wrong or impossible as written, stop. Write what blocked you and where in
`.handoff/report.md`, and don't improvise around it.
