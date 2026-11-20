## Goal

Let the user download a finished run's result: a **zip of the project files** at the end of the
run, or a **git bundle** of its commits. Both are built **on the host, only from the run's exported
patches** (`<run>/out/*.patch`) applied to a fresh copy of trusted source code — the same way
pushes work. **Never read, copy or zip the run's `work/` folder**: its `.git` is controlled by the
agent (hooks, `core.fsmonitor`, `core.hooksPath`, filters), and the host never runs git there
(security rule #2 in `AGENTS.md`).

Surfaces: `hive export [run] [--zip | --bundle] [-o <path>] [--force]` in the CLI, and **Download
zip** / **Download git bundle** buttons on a finished run in the web UI.

## Files to touch

- `src/runs.ts`
- `src/web-runs.ts`
- `src/cli.ts`
- `ui/src/main.ts`
- `ui/src/app.css`
- `test/export.test.mjs` (new)
- `test/web-runs.test.mjs`
- `README.md`
- `AGENTS.md`
- `.handoff/report.md`

## Steps

1. Run `npm ci`, then `npm run build:vm`.

2. `src/runs.ts`: `export async function exportRun(dir: string, format: "zip" | "bundle", outPath:
   string): Promise<{ path: string; commits: number }>`:
   - Refuse with `"run is still going"` when `isLive(meta)`, and with `"no commits to export"` when
     `patchFiles(dir)` is empty.
   - **Trusted source:** `<dir>/origin` when it exists (remote and new-project runs, and local runs
     after `hive push`); otherwise `meta.repo` (a local run's own checkout, which is the user's
     repo). Never `<dir>/work`.
   - Make a temp dir (`mkdtempSync(join(tmpdir(), "hive-export-"))`), clone the source into it with
     the existing `git()` helper from `src/git.ts` (it already disables hooks and fsmonitor):
     `git(["clone", "-q", "--no-hardlinks", "--no-checkout", "--", source, tmp], undefined,
     120_000)`, then `git(["checkout", "-q", "-B", "hive-export", meta.base], tmp)`, then
     `git([...identity, "am", "-q", "--keep-cr", ...patchFiles(dir)], tmp, 120_000)` with the
     configured author identity (`-c user.name=... -c user.email=...` from `config.git`, as
     `applyAndPush` in `src/git.ts` does). A base commit missing from the source → throw
     `` `the run's base commit is no longer in ${source}` ``; a failing `git am` → run `git am
     --abort` and throw `` `couldn't apply the run's commits: <message>` ``.
   - **zip:** `git(["archive", "--format=zip", "--prefix=<repo name>/", "-o", outPath,
     "hive-export"], tmp)`, where `<repo name>` is the run folder name without its
     `-YYYYMMDD-HHMMSS` suffix (`basename(dir).replace(/-\d{8}-\d{6}(-\d+)?$/, "")`), or `project`
     if that is empty.
   - **bundle:** rename the branch to `hive/<run name>` (`git branch -M hive/<run name>`), then
     `git(["bundle", "create", outPath, "hive/<run name>"], tmp, 120_000)` (full history, so
     `git clone <file>.bundle` works on its own).
   - Always remove the temp dir in `finally`. Return `{ path: outPath, commits: patchFiles(dir).length }`.

3. `src/cli.ts`: `hive export [run] [--zip | --bundle] [-o <path>] [--force]` (default `--zip`;
   both flags → usage error). The run defaults to the newest, like `hive diff`, via `resolveRun`.
   Default output: `<cwd>/<run name>.zip` or `.bundle`. Refuse to overwrite an existing file unless
   `--force`. Print the path, the number of commits, and for a bundle the hint
   `git clone <path> <folder>`. Add it to the usage text.

4. `src/web-runs.ts`: `GET /export/:sessionId?format=zip|bundle` (inside the authenticated scope
   like the other routes; 404 for an unknown run as the others do; 400 `{ error: "format must be
   zip or bundle" }`; 409 `{ error: "Run is still going" }` when live; 400 with the `exportRun`
   message for other errors). Build into a temp file (`mkdtempSync` under `tmpdir()`), then reply
   with the file contents, `Content-Type` `application/zip` or `application/x-git-bundle`, and
   `Content-Disposition: attachment; filename="<run name>.<ext>"`. Delete the temp dir after the
   reply is sent (read the file into a Buffer first, then remove the dir, then send the Buffer).

5. `ui/src/main.ts`: in the finished-run banner (where `changesElement`, `prElement` and
   `issueElement` are appended, around `banner.append(changesElement(item.changes))`), when the run
   has commits (`item.changes` with at least one commit), append an `exportElement(item)` with two
   buttons, **Download zip** (`id="downloadZipBtn"`) and **Download git bundle**
   (`id="downloadBundleBtn"`), and a hint: `Built from the run's commits on this computer.` Each
   button fetches `/export/<sessionId>?format=...` with the existing `api()` helper (it sends the
   token), shows `Preparing…` while waiting, turns the response into a Blob, and saves it through a
   temporary `<a download="<filename from Content-Disposition, else run id + ext>">` with an object
   URL (revoke it afterwards). On an error response show the server's `error` in an
   `alert alert-danger` under the buttons, like `prElement` does. Reuse the existing `.pr-actions`
   and button classes; add CSS to `ui/src/app.css` only if something needs it.

6. Tests:
   - `test/export.test.mjs` (new; set `HIVE_RUNS_DIR`, `HIVE_KEYS_FILE`, `HIVE_DOTENV_PATH` to temp
     paths before importing `../dist/`, like `test/web-runs.test.mjs`). Build a fake run folder:
     an `origin/` git repo with one base commit (`README.md`), an `out/0001-*.patch` made with
     `git format-patch` from a scratch clone that adds `hello.txt` in one commit, and a
     `meta.json` (`status: "done"`, `commits: 1`, `source: "remote"`, `base` = the base sha, plus
     the other required fields). **Do not create `work/`** (export must not need it). Check:
     - zip: the file exists and its central directory lists `<name>/hello.txt` and
       `<name>/README.md` (read it with `python3 -m zipfile -l <file>` or by searching the bytes for
       the names; pick one that works in the VM);
     - bundle: `git clone <file> <dir>` works and `git log --format=%s` there includes the patch's
       subject;
     - a run with no patches rejects with `no commits to export`;
     - a run whose meta says `status: "running"` with `pid: process.pid` rejects with
       `run is still going`;
     - a `work/` folder containing a `.git/hooks/post-checkout` script that writes a marker file
       is **not** run: create it, export, and assert the marker file does not exist.
   - `test/web-runs.test.mjs`: `GET /export/<id>?format=zip` on the fake run from that file's
     setup returns 400 `no commits to export` (it has 0 commits); `format=tar` → 400; an unknown id
     → 404.

7. Docs: `README.md` — `hive export` and the web UI's Download buttons, and that exports are built
   from the run's patches on the host. `AGENTS.md` — add `exportRun` to the `src/runs.ts` row and
   `/export` to the `src/web-runs.ts` row of the layout table, and add to security rule #2 that
   exports, like pushes, are built from the patches in a fresh clone, never from `work/`.

## Acceptance

- `npm run build` exits 0.
- `npm run build:ui` exits 0.
- `npm test` exits 0.
- `node --test test/export.test.mjs test/web-runs.test.mjs` exits 0 (after `npm run build`).
- `grep -n '"work"' src/runs.ts` shows no new use of `work` inside `exportRun` (check by reading
  the function; note the result in the report).
- `git status --short` lists no files other than those in **Files to touch**.

## Parallel work

None — do it sequentially.

## Constraints

- Do not commit, push, or switch branches.
- A step may touch a file outside **Files to touch** when it has to (the clone lives in a
  throwaway VM and is discarded), but every such file must appear in the report under "outside
  the plan", one line each saying why. Installing dependencies and temporary files outside the repo
  are fine.
- The only checks to run are the **Acceptance** commands. Never boot a VM, start `hive run`, start
  the server or call GitHub. If something outside Acceptance fails, note it in the report and
  finish.
- `exportRun` must never read, copy, archive or run git in `<run>/work`. All host git goes through
  the `git()` helper in `src/git.ts`. No new dependencies (no zip library: `git archive` makes the
  zip).
- Don't change `vm/`, `image/`, `src/sandbox.ts` or the run steps.
- Write `.handoff/report.md` as soon as Acceptance has been run, then stop.

## Out of scope

- Exporting a run with no commits, exporting uncommitted work, uploads anywhere.

## If blocked

Stop, write `.handoff/report.md` saying which step failed, the exact command and its error, and
what you tried. Do not improvise around the plan.
