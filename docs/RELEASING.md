# Releasing Agent Hive

Releases are **signed**. `scripts/build-release.sh` produces the Linux x86_64 app bundle with a
bundled Node.js, the hardened VM launcher, libkrun, libkrunfw and a static pasta fallback, plus
the VM rootfs as a separate download. On Apple silicon, `scripts/build-release-macos.sh` builds
the arm64 bundle and its `.img.gz` image the same way (no pasta: the VM has no IP network). Each
release also uploads the GPL corresponding source of the kernel libkrunfw contains and, on Linux,
of the passt sources the static pasta is built from. `SHA256SUMS` covers all of it. Stable releases are signed **keyless** in CI: `promote.yml` signs
with the run's GitHub OIDC token, and `hive update` accepts the result only when the certificate
names that workflow, in this repository, at `main`. There is no signing key on this machine.

## Two channels: test, then promote

`test.yml` runs on **every push to `main`** and **daily**. It builds the VM image from freshly
pulled distro packages, builds the bundle, boots both in a real VM (`scripts/vm-smoke.mjs`), and
replaces a rolling prerelease tagged `test`. That is the test channel: always the newest packages,
always booted before it is published, and never what users get. One build exists at a time, so
nothing accumulates.

`promote.yml` is the only thing that reaches users. It **builds nothing**: it downloads the files
from the `test` release, checks them against the tested `SHA256SUMS`, signs that file keyless with
this run's OIDC token, and publishes it as `v<version>`. So what a user installs is byte-for-byte
what the test run booted — the microVM filesystem included, because the rootfs tarball is the same
file, named by its content.

1. Wait for the **Test build** run on `main` to pass (or run it yourself).
2. Actions → **Promote to stable** → *Run workflow*. The form has no fields.
3. Approve the `stable-release` environment as the reviewer account — the one that never runs
   coding agents.
4. It reads the version from the tested bundle, refuses if that version is already released,
   verifies every file, signs `SHA256SUMS`, and publishes.

**How the numbers work.** `test.yml` works out the next patch (the newest release is `v0.5.8`, so
the build is `0.5.9`) and bakes it into the bundle. Promotion reuses that number rather than
working it out again: a promoted build must keep the version it was built and tested with, or the
bundle inside the tarball would disagree with its release tag.

The job refuses to sign when `stable-release` has no required reviewer, so an environment that was
never configured cannot publish (GitHub would otherwise create it unprotected on first use).

The release build needs podman (it builds the VM image and packs the rootfs inside
`podman unshare`, since the image has files only root may read).

**Native pieces and pins.** `scripts/build-native.sh` builds libkrun and the hardened `hive-vm`
launcher inside the pinned `manylinux_2_28` container (glibc 2.28, so they run on Ubuntu 20.04+,
Debian 11+, RHEL/Alma/Rocky 8+, Mint, Fedora, Arch and WSL distros), downloads upstream's
prebuilt libkrunfw, checking it against a pinned SHA-256, and builds a static `pasta` from the
pinned passt source tarball (checked on the host before it enters the container). It needs podman
and network; the first build takes several minutes, and later runs reuse `build/native/` while
`versions.json` and `vm/hive-vm.c` are unchanged (`bash scripts/build-native.sh --force` rebuilds
anyway). The container refuses output that needs a newer glibc symbol or unexpected shared
libraries, and a pasta that isn't statically linked (no `NEEDED` entries, no `INTERP` program
header); it also checks that `pasta --version` runs and warns if its version text doesn't mention
the pin.

Every pin — libkrun's tag and commit, libkrunfw's version, its x86_64 URL and SHA-256 plus the
macOS prebuilt and Linux arm64 assets, passt's version, URL and SHA-256, the Rust toolchain, the
manylinux build image digest and the bundled Node version — lives in `versions.json`. Bumping one
is just editing that file; `scripts/build-native.sh` and `scripts/build-native-macos.sh` rebuild
when the file's hash changes.

**macOS native pieces.** `scripts/build-native-macos.sh` runs on Apple silicon only (Xcode
command line tools, Rust, make, network). It builds libkrun from the pinned commit, downloads
libkrunfw's pinned `libkrunfw-prebuilt-aarch64.tgz`, compiles the one `libkrunfw.5.dylib`, compiles
`vm/hive-vm.c` with the HVF entitlements and ad-hoc signs all three. The launcher preloads
libkrunfw from libkrun's own directory, so `lib/` must keep the two dylibs together; the script
sets their install names and verifies the launcher's signature. On a Mac without
Hypervisor.framework (including GitHub's macOS runners) it skips the launcher's `--check`.

**Test a real VM before shipping a libkrun or libkrunfw bump**, including DNS and HTTPS from inside
it: build checks and unit tests can't see a guest-kernel regression. libkrunfw 5.6.4 (November
2026) booted fine but broke DNS in the VM, so the pin stays on 5.6.2, the version Fedora ships,
until a newer one passes that check.

## Pinned versions

| Pin | Where it is used |
|-----|------------------|
| `libkrun` (tag, commit) | Built from source in `scripts/build-native.sh`; the commit is verified after cloning |
| `libkrunfw` (version, URL, SHA-256; `macos.aarch64`, `linux.aarch64`) | Upstream's prebuilt x86_64 tarball for Linux, the macOS prebuilt kernel bundle, and the Linux arm64 library; `scripts/build-native.sh` and `scripts/build-native-macos.sh` check the ones they use |
| `passt` (version, URL, SHA-256) | The source tarball `scripts/build-native.sh` builds the static `pasta` fallback from; its licenses ship in `share/licenses/passt/` |
| `rust` | The toolchain `scripts/native-in-container.sh` installs with rustup |
| `buildImage` | The `manylinux_2_28` image digest the native build runs in |
| `node` | The Node.js version bundled in the app (`HIVE_NODE_VERSION` still overrides it) |
| `skip` | Upstream versions known to be broken for hive, per component, with the reason. The daily bump check never offers them (libkrunfw 5.6.4: DNS fails in the VM) |

## Build a release by hand

For an app-only change, or when the VM filesystem needs a forced rebuild:

1. Bump `version` in `package.json`.
2. Build:

   ```bash
   npm run release
   ```

   A hand build always rebuilds the VM filesystem from a freshly pulled base image with podman's
   cache skipped, so Fedora and Chromium security updates are in.

   **What users re-download.** A release names its VM filesystem by the id from
   `scripts/rootfs-id.mjs`: the `image/` tree plus the exact set of installed RPMs. An installed
   hive downloads it only when that id differs from the one it has, so rebuilding an unchanged
   image — which `build:image:fresh` does on every release — costs the user nothing. It used to be
   the podman image id, which changed on every build because of `--no-cache`, so every release
   made every install download the whole 660 MB again.

   Reusing a rootfs another machine already built is possible by handing over a tarball whose
   `rootfs-info.json` (next to it) names this checkout's `image/` tree:

   ```bash
   npm run release -- --reuse-rootfs <path to hive-rootfs-<rver>-linux-x86_64.tar.gz>
   ```

   The build refuses a rootfs from another image tree; that check is `scripts/release-rootfs.mjs`.
   `HIVE_RELEASE_VERSION` overrides `package.json`'s version (`test.yml` uses it), and `HIVE_RELEASE_SKIP_SOURCES=1` skips the GPL source assets.

   **macOS (Apple silicon)** needs the arm64 image, which is built on arm64 Linux (the
   `macos-image` workflow, or `npm run build:rootfs-image` on a `podman machine`), plus the
   macOS native build. On the Mac:

   ```bash
   HIVE_SIGNING_KEY=~/.config/agent-hive/release-signing-key.pem \
     bash scripts/build-release-macos.sh \
     --rootfs-image hive-rootfs-<id>-linux-arm64.img.gz
   ```

   That writes `hive-<version>-darwin-arm64.tar.gz`, the image, libkrunfw's source and its kernel
   tarball, and a signed `SHA256SUMS`. Run it in a release directory that already has the Linux
   assets (run the Linux build first) and it re-signs one `SHA256SUMS` covering both platforms;
   otherwise the macOS assets stand alone. The bundle's `ROOTFS_VERSION` names the image, which is
   how `installRelease` pairs them.

   The image must come with its `rootfs-info.json` (written by `build-rootfs-image.sh`); the
   build refuses an image whose `imageTree` differs from this checkout's `HEAD:image`, exactly
   like the Linux build. Set `HIVE_ROOTFS_INFO` when the file lives somewhere else.

   The build also runs `scripts/build-native.sh` for libkrun, libkrunfw and the launcher (podman
   and network; see above), and downloads the GPL source assets described below.

   **GPL source:** libkrunfw contains the Linux kernel (GPL-2.0) and the bundled pasta is built
   from the passt sources (GPL-2.0-or-later), so a release publishes the corresponding source too:
   libkrunfw's source at the pinned tag, the kernel tarball its `Makefile` builds from, and the
   passt source tarball the static pasta was built from. `scripts/build-release.sh` downloads the
   first two and copies the host-verified passt tarball into `release/<version>/`, then lists all
   of them in `SHA256SUMS`. Set `HIVE_RELEASE_SKIP_SOURCES=1` to skip these assets.
3. Publish:

   ```bash
   gh release create v<version> release/<version>/* --title v<version> --notes "<notes>"
   ```

## Automation

`.github/workflows/` keeps `main` at the newest upstream pins, rebuilds the VM image from scratch
every day to pick up Fedora's security updates, and publishes releases from `main` when asked.

### Repository settings the automation depends on

Set once, in the `Old-GenS` organization and its `agent-hive` repository:

| Setting | Where | Value |
|---|---|---|
| Ruleset `main` | Settings › Rules | requires a pull request (0 approvals) and the `test`, `vm`, `windows-installer` checks; blocks force-pushes and deletion; **no bypass list** |
| Allow auto-merge | Settings › General › Pull requests | on — the bots use it, and there is no merge workflow of our own |
| Merge types | Settings › General › Pull requests | merge commit only (no squash or rebase, so a merged branch keeps its SHAs) |
| Delete branch on merge | Settings › General › Pull requests | on |
| Workflow permissions | Organization Settings › Actions › General | "Read and write permissions" — the org default is read-only, which makes publishing a release fail with `Resource not accessible by integration`; workflows ask for write explicitly |
| Allow GitHub Actions to create pull requests | Organization Settings › Actions › General | on — `dependabot-automerge.yml` needs it, and a workflow that opens a PR with `GITHUB_TOKEN` does not trigger other workflows |
| Secret scanning + push protection | Settings › Code security | on (free on a public repo); non-provider patterns is GHAS-only |

### What signs what

Releases are signed keyless by `.github/workflows/promote.yml`, which runs on `main`. Installers
accept them when the certificate names
`https://github.com/Old-GenS/agent-hive/.github/workflows/promote.yml@refs/heads/main` under the
GitHub Actions issuer (`RELEASE_SIGNING_IDENTITY` in `src/release-key.ts`). There is no signing key:
the ed25519 key releases used before this is kept only so an install can still verify an older
`SHA256SUMS.sig`.

**Changing who may release:** edit `src/release-key.ts` and the `stable-release` environment. The
environment is the gate that requires a reviewer. The workflows themselves are not: the `main`
ruleset asks for no approving review and does not require a code owner, and there is no
`CODEOWNERS` file. A token that can push to `main` can change `promote.yml`.

### Branches and pull requests

- `main` is the only branch, and nobody pushes to it directly: the `main` ruleset requires a pull
  request plus the `test`, `vm` and `windows-installer` checks, and blocks force-pushes and
  deletion. It has no bypass list, so the maintainer's own changes take the same route. Pull
  requests need no approval (the checks are the gate) and merge through GitHub's auto-merge as
  merge commits.
- The update automation goes through pull requests, merged by **GitHub's auto-merge** (the
  repository setting, enabled per pull request with `gh pr merge --auto`): GitHub waits for the
  required checks and merges. There is no merge workflow of our own.
- Dependabot can't enable auto-merge on its own pull requests (a bot may not merge its own work), so
  `dependabot-automerge.yml` makes that one call; the waiting and merging are GitHub's.
- Pull requests opened with `GITHUB_TOKEN` don't start workflows on their own, so the bump workflow
  dispatches `ci.yml` on its branch before enabling auto-merge; that run's checks land on the same
  commit.

### The daily bump check

Renovate (`.github/workflows/` has nothing for it: the **Mend Renovate** app is installed on the
repository) reads `versions.json` and the `image/Containerfile` ARG through the regex managers in
`renovate.json`. It lists what moved on the Dependency Dashboard and opens a pull request for a pin
it can update in one field. `enabledManagers` is `custom.regex` only, so npm and GitHub Actions
stay with Dependabot and nothing is watched twice.

`scripts/check-updates.mjs --apply <component>` is still how a pin whose value appears in several
fields gets bumped — version, the URLs that embed it, and the SHA-256, together. `--list` prints
what moved without touching the files. The sources it reads:

| Component | Source |
|---|---|
| libkrun | `containers/libkrun`'s latest GitHub release; the commit from `git ls-remote` |
| libkrunfw | `containers/libkrunfw`'s latest GitHub release and its `libkrunfw-x86_64.tgz` |
| passt | `git ls-remote --tags https://passt.top/passt`, newest dated tag, snapshot tarball |
| rust | `static.rust-lang.org/dist/channel-rust-stable.toml` |
| buildImage | the `manylinux_2_28_x86_64` `latest` tag on quay.io |
| node | nodejs.org's index, newest release of the pinned major |
| pi | `@earendil-works/pi-coding-agent` on npm |

A pin that is several fields at once (libkrun's tag and commit, libkrunfw's version, three asset
URLs and a SHA-256, passt's version, URL and SHA-256) is marked `dependencyDashboardApproval` in
`renovate.json`: Renovate says what moved, and a human runs the bump. That is deliberate — a regex
manager would update one field and leave the rest pointing at the old release, which builds
something that never existed.

### The daily security rebuild

`security.yml` runs daily at 06:00 UTC — 23:00 in Vancouver — and can be dispatched by hand. It
builds nothing that gets published: it runs the release build with `--skip-sign`, which pulls the
Fedora base again, skips the podman cache and exports a new rootfs, so Chromium, git and the other
packages a task uses pick up their security updates. It then boots that rootfs in a real VM with
`scripts/vm-smoke.mjs`.

A failure is a red daily run, which GitHub mails to the repository owner. There is no plan, no
version number, no rootfs reuse rule and no key: the whole workflow is the build and the boot.

### macOS builds

`.github/workflows/macos-release.yml` (manual dispatch) reuses the `macos-image` workflow on
`ubuntu-24.04-arm`, then builds the bundle on `macos-15` and uploads it as a workflow artifact.
It signs with a throwaway key and does not publish: GitHub's macOS runners cannot nest
Hypervisor.framework, and the stable key must not be in CI. Use it to check that the macOS build
still works, and build the distributable release on a Mac. `test.yml` only builds Linux assets;
a macOS release is a separate, manual build.


## What each file is

| File | What |
|------|------|
| `release/<version>/hive-<version>-linux-x86_64.tar.gz` | The app bundle: `bin/hive` (a `sh` wrapper), `lib/hive.mjs` (the CLI as one esbuild file), `lib/libkrun.so.1` and `lib/libkrunfw.so.5` (the old-glibc native pieces, with `RUNPATH=$ORIGIN`), `libexec/node` (bundled Node), `libexec/hive-vm` (hardened launcher), `libexec/pasta` (the static pasta fallback), `share/licenses/` (libkrun, libkrunfw, passt and hive's own MIT license), `VERSION`, `ROOTFS_VERSION`. |
| `release/<version>/hive-rootfs-<rootfs-version>-linux-x86_64.tar.gz` | The VM root filesystem, extracted under `~/.local/share/agent-hive/rootfs/<rootfs-version>`. A new download is only needed when the rootfs version changes. |
| `release/<version>/hive-<version>-darwin-arm64.tar.gz` | The macOS arm64 app bundle: the same layout as the Linux one, with `lib/libkrun.1.dylib` and `lib/libkrunfw.5.dylib` (kept together), `libexec/node` for `darwin-arm64`, the ad-hoc-signed launcher and no pasta. |
| `release/<version>/hive-rootfs-<rootfs-version>-linux-arm64.img.gz` | The macOS VM filesystem: a gzipped raw ext4 image attached read-only. Its name and `ROOTFS_VERSION` must match the darwin bundle. |
| `release/<version>/libkrunfw-<version>-source.tar.gz` | libkrunfw's source at the pinned tag (GPL/LGPL corresponding source). |
| `release/<version>/kernel-source-<file>` | The kernel tarball libkrunfw's `Makefile` downloads (its `KERNEL_REMOTE`); with libkrunfw's source (config and patches) it is the GPL-2.0 corresponding source. |
| `release/<version>/passt-<version>-source.tar.xz` | The passt source tarball (GPL-2.0-or-later / BSD-3-Clause corresponding source) the static `pasta` was built from. |
| `release/<version>/SHA256SUMS` | SHA-256 of the app, the rootfs and the source tarballs. |
| `release/<version>/SHA256SUMS.sigstore.json` | The keyless signature over `SHA256SUMS` (a sigstore bundle), verified by `hive update` against the release workflow's identity. |
| `release/<version>/SHA256SUMS.sig` | Base64 ed25519 signature, used by the nightlies. |
| `release/<version>/rootfs-info.json` | Which rootfs this release ships (`rootfs`), the `image/` git tree it was built from (`imageTree`) and when it was built (`built`). Not in `SHA256SUMS` (clients never read it). |

`install-cli.sh` checks the download against `SHA256SUMS` over HTTPS but does not verify the
signature; `hive update` checks both before switching versions.

Installers put versions under `~/.local/share/agent-hive/versions/<version>` and switch the
`current` symlink atomically, keeping `previous` for `hive update --rollback`.
