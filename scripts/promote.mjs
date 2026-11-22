#!/usr/bin/env node
/**
 * Promote a tested nightly build to a stable release, and make sure the two match.
 *
 * The stable release is not rebuilt from whatever `main` happens to be: the app is built from the
 * exact commit the nightly release was built from, and the VM filesystem is reused from that
 * nightly's release, after checking that its rootfs-info.json names this commit's `image/` tree.
 * Before anything is published the nightly's SHA256SUMS signature is checked against
 * PRERELEASE_PUBLIC_KEY, and after the build the release's own SHA256SUMS.sig is checked against
 * RELEASE_PUBLIC_KEY, so a stable release cannot be signed with the wrong key.
 *
 * Usage:
 *
 *   npm run promote -- v0.5.6-nightly.3             build + verify release/0.5.6/
 *   npm run promote -- v0.5.6-nightly.3 --publish   ... and create the GitHub release
 *   npm run promote -- v0.5.6-nightly.3 --dry-run   check the nightly, build nothing
 *
 * Before promoting, bump `version` in package.json to the stable version and merge that; the
 * command refuses otherwise. It needs podman, network, `gh`, and the stable signing key
 * (`HIVE_SIGNING_KEY`, default ~/.config/agent-hive/release-signing-key.pem).
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ROOTFS_NAME,
  isPrereleaseTag,
  readPublicKey,
  stableVersionFromTag,
  sumsEntry,
  validateRootfs,
  verifySums,
} from "./release-rootfs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim();
    fail(`${command} ${args.join(" ")} failed${detail === "" ? "" : `:\n${detail}`}`);
  }
  return (result.stdout ?? "").trim();
}

/** Run a step that writes its own progress to the terminal. */
function runVisible(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed (exit ${result.status})`);
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

function releaseKeys() {
  const source = readFileSync(join(root, "src/release-key.ts"), "utf8");
  return {
    stable: readPublicKey(source, "RELEASE_PUBLIC_KEY"),
    prerelease: readPublicKey(source, "PRERELEASE_PUBLIC_KEY"),
  };
}

function repoVersion() {
  return JSON.parse(run("git", ["show", "HEAD:package.json"])).version;
}

function nightlyReleaseInfo(tag) {
  const json = JSON.parse(
    run("gh", [
      "release",
      "view",
      tag,
      "--json",
      "isDraft,isPrerelease,tagName,url,assets",
    ]),
  );
  if (json.isDraft) fail(`${tag} is a draft release`);
  if (!json.isPrerelease) fail(`${tag} is not a prerelease; only a tested nightly can be promoted`);
  return json;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      publish: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1) {
    fail("usage: npm run promote -- <nightly tag> [--publish | --dry-run]");
  }
  if (values.publish && values["dry-run"]) fail("--publish and --dry-run cannot be combined");

  // Accept the tag with or without its leading v.
  const input = positionals[0];
  if (!isPrereleaseTag(input)) {
    fail(`"${input}" is not a nightly tag; pass one like v0.5.6-nightly.3`);
  }
  const tag = input.startsWith("v") ? input : `v${input}`;
  const version = stableVersionFromTag(tag);

  console.log(`promote: ${tag} → stable v${version}`);
  if (values["dry-run"]) console.log("promote: dry run; nothing will be built or published");

  runVisible("git", ["fetch", "--tags", "--force", "--quiet", "origin"]);

  // Release from main, in sync with GitHub: the version bump is merged there before promoting.
  const head = run("git", ["rev-parse", "HEAD"]);
  const originMain = run("git", ["rev-parse", "origin/main"]);
  if (head !== originMain) {
    fail("check out main at origin/main first (git switch main && git pull --ff-only)");
  }
  const headVersion = repoVersion();
  if (headVersion !== version) {
    fail(
      `package.json on main is ${headVersion}, but promoting ${tag} makes stable ${version}. ` +
        `Bump package.json to ${version}, commit it, and merge it first.`,
    );
  }

  let commit;
  try {
    commit = run("git", ["rev-parse", `${tag}^{commit}`]);
  } catch {
    fail(`${tag} is not a tag on origin`);
  }
  const shortCommit = commit.slice(0, 12);
  console.log(`promote: nightly commit ${shortCommit}`);

  nightlyReleaseInfo(tag);

  // Everything the release needs to prove it matches the nightly goes into one directory whose
  // lifetime is this command.
  const work = mkdtempSync(join(tmpdir(), "hive-promote-"));
  const nightlyDir = join(work, "nightly");
  mkdirSync(nightlyDir, { recursive: true });
  let worktree;
  try {
    console.log("promote: downloading the nightly's checksums and rootfs info");
    runVisible("gh", [
      "release",
      "download",
      tag,
      "--pattern",
      "SHA256SUMS",
      "--pattern",
      "SHA256SUMS.sig",
      "--pattern",
      "rootfs-info.json",
      "--dir",
      nightlyDir,
      "--clobber",
    ]);

    const sums = readFileSync(join(nightlyDir, "SHA256SUMS"));
    const signature = readFileSync(join(nightlyDir, "SHA256SUMS.sig"), "utf8");
    const info = JSON.parse(readFileSync(join(nightlyDir, "rootfs-info.json"), "utf8"));
    const keys = releaseKeys();

    if (!verifySums(sums, signature, keys.prerelease)) {
      fail(`${tag}'s SHA256SUMS is not signed by the prerelease key; refusing to promote it`);
    }
    console.log("promote: nightly signature ok (prerelease key)");

    // The rootfs asset the nightly shipped; its name and rootfs-info.json both name its id.
    const rootfsName = sums
      .toString("utf8")
      .split("\n")
      .map((line) => /^[0-9a-f]{64}\s+\*?(.+)$/.exec(line.trim())?.[1])
      .find((name) => name !== undefined && ROOTFS_NAME.test(name));
    if (rootfsName === undefined) fail(`${tag} has no hive-rootfs-<id>-linux-x86_64.tar.gz asset`);

    const commitImageTree = run("git", ["rev-parse", `${commit}:image`]);
    const rver = validateRootfs({ name: rootfsName, info, imageTree: commitImageTree });
    console.log(`promote: nightly rootfs ${rver} was built from this commit's image/ tree`);

    const sumsHash = sumsEntry(sums.toString("utf8"), rootfsName);
    if (sumsHash === undefined) fail(`${rootfsName} is not listed in ${tag}'s SHA256SUMS`);

    if (values["dry-run"]) {
      console.log(
        `promote: would build v${version} from ${shortCommit} and reuse the nightly's rootfs ${rver}`,
      );
      return;
    }

    console.log("promote: downloading the nightly's rootfs (about 660 MB)");
    runVisible("gh", [
      "release",
      "download",
      tag,
      "--pattern",
      rootfsName,
      "--dir",
      nightlyDir,
      "--clobber",
    ]);
    const rootfsPath = join(nightlyDir, rootfsName);
    const actualHash = await sha256File(rootfsPath);
    if (actualHash !== sumsHash) fail(`${rootfsName} does not match the nightly's SHA256SUMS`);

    // Build from the nightly's commit: the app code is exactly what CI tested, and package.json's
    // version is the only thing the stable build changes (through HIVE_RELEASE_VERSION).
    worktree = join(work, "checkout");
    console.log(`promote: checking out ${shortCommit} in a temporary worktree`);
    run("git", ["worktree", "add", "--detach", worktree, commit], { cwd: root });
    console.log("promote: installing dependencies in the checkout");
    runVisible("npm", ["ci", "--no-audit", "--no-fund"], { cwd: worktree });

    console.log(`promote: building v${version}`);
    runVisible("bash", ["scripts/build-release.sh", "--reuse-rootfs", rootfsPath], {
      cwd: worktree,
      env: { ...process.env, HIVE_RELEASE_VERSION: version },
    });

    // Prove the artifacts are the ones the checks above approved, and that the release carries the
    // stable signature (the build used HIVE_SIGNING_KEY; this catches a prerelease key by mistake).
    const out = join(worktree, "release", version);
    if (!existsSync(join(out, `hive-${version}-linux-x86_64.tar.gz`))) {
      fail(`the build did not produce hive-${version}-linux-x86_64.tar.gz`);
    }
    const builtRootfs = readFileSync(join(out, "ROOTFS_VERSION"), "utf8").trim();
    if (builtRootfs !== rver) fail(`the release records rootfs ${builtRootfs}, expected ${rver}`);
    const builtInfo = JSON.parse(readFileSync(join(out, "rootfs-info.json"), "utf8"));
    if (builtInfo.imageTree !== commitImageTree) {
      fail("the release's rootfs-info.json does not name the promoted commit's image/ tree");
    }
    const builtRootfsPath = join(out, rootfsName);
    if (!existsSync(builtRootfsPath) || (await sha256File(builtRootfsPath)) !== sumsHash) {
      fail("the release does not contain the nightly's rootfs tarball");
    }
    const builtSums = readFileSync(join(out, "SHA256SUMS"));
    const builtSig = readFileSync(join(out, "SHA256SUMS.sig"), "utf8");
    if (!verifySums(builtSums, builtSig, keys.stable)) {
      fail("the release's SHA256SUMS is not signed by the stable key");
    }
    console.log("promote: release matches the nightly (commit, rootfs, both signatures)");

    // Keep the output where a normal `npm run release` leaves it.
    mkdirSync(join(root, "release"), { recursive: true });
    rmSync(join(root, "release", version), { recursive: true, force: true });
    cpSync(out, join(root, "release", version), { recursive: true });
    console.log(`promote: wrote release/${version}/`);

    if (!values.publish) {
      console.log(
        `promote: publish with:\n  gh release create v${version} release/${version}/* ` +
          `--title v${version} --notes-file <notes>`,
      );
      return;
    }

    try {
      run("gh", ["release", "view", `v${version}`]);
      fail(`v${version} already exists on GitHub; refusing to replace it`);
    } catch (err) {
      if (!/not found|release not found/i.test(err instanceof Error ? err.message : "")) throw err;
    }

    const notes = [
      `Promoted from the tested nightly build ${tag}.`,
      "",
      `- App: built from ${shortCommit}, the commit that nightly build tested.`,
      `- VM filesystem: \`${rootfsName}\` reused from that nightly release (the rootfs its CI run booted).`,
      `- Signed with the stable release key.`,
      "",
      `Users who already have VM filesystem ${rver} do not download it again.`,
    ].join("\n");
    const notesFile = join(work, "notes.md");
    writeFileSync(notesFile, notes + "\n");
    const assets = readdirSync(join(root, "release", version)).map((name) =>
      join(root, "release", version, name),
    );
    console.log(`promote: publishing v${version}`);
    runVisible("gh", [
      "release",
      "create",
      `v${version}`,
      ...assets,
      "--title",
      `v${version}`,
      "--notes-file",
      notesFile,
    ]);
    console.log(`promote: published v${version}`);
  } finally {
    if (worktree !== undefined) {
      try {
        run("git", ["worktree", "remove", "--force", worktree], { cwd: root });
      } catch {
        // A failed cleanup must not hide the real error.
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`promote: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
