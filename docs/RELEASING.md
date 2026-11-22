# Releasing Agent Hive

Releases are **signed**. `scripts/build-release.sh` produces an app bundle with a bundled
Node.js, the hardened VM launcher, libkrun, libkrunfw and a static pasta fallback, plus the VM
rootfs as a separate download. Each release also uploads the GPL corresponding source of the
kernel libkrunfw contains and of the passt sources the static pasta is built from. `SHA256SUMS`
covers all of it and is signed by an ed25519 key that lives only on the release machine.

## One-time setup

```bash
node scripts/keygen.mjs ~/.config/agent-hive/release-signing-key.pem > /tmp/release-key.pub
```

Paste the printed public key into `src/release-key.ts` as `RELEASE_PUBLIC_KEY` and commit it.
`hive update` refuses to install a release whose `SHA256SUMS` isn't signed by that key. Never
commit the private key.

**Back up the private key** (for example in a password manager, or offline). Installed copies only
accept updates signed by it: if it's lost, a new key means everyone has to reinstall by hand with
`install-cli.sh`. If it leaks, publish a release with a new key straight away and say so in the
release notes.

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

Every pin — libkrun's tag and commit, libkrunfw's version, URL and SHA-256, passt's version, URL
and SHA-256, the Rust toolchain, the manylinux build image digest and the bundled Node version —
lives in `versions.json`. Bumping one is just editing that file; `scripts/build-native.sh`
rebuilds when the file's hash changes.

**Test a real VM before shipping a libkrun or libkrunfw bump**, including DNS and HTTPS from inside
it: build checks and unit tests can't see a guest-kernel regression. libkrunfw 5.6.4 (November
2026) booted fine but broke DNS in the VM, so the pin stays on 5.6.2, the version Fedora ships,
until a newer one passes that check.

## Pinned versions

| Pin | Where it is used |
|-----|------------------|
| `libkrun` (tag, commit) | Built from source in `scripts/build-native.sh`; the commit is verified after cloning |
| `libkrunfw` (version, URL, SHA-256) | Upstream's prebuilt x86_64 tarball, downloaded and checked by `scripts/build-native.sh` |
| `passt` (version, URL, SHA-256) | The source tarball `scripts/build-native.sh` builds the static `pasta` fallback from; its licenses ship in `share/licenses/passt/` |
| `rust` | The toolchain `scripts/native-in-container.sh` installs with rustup |
| `buildImage` | The `manylinux_2_28` image digest the native build runs in |
| `node` | The Node.js version bundled in the app (`HIVE_NODE_VERSION` still overrides it) |
| `skip` | Upstream versions known to be broken for hive, per component, with the reason. The daily bump check never offers them (libkrunfw 5.6.4: DNS fails in the VM) |

## Cut a release

1. Bump `version` in `package.json`.
2. Build:

   ```bash
   npm run release
   ```

   Set `HIVE_SIGNING_KEY` to use a key other than `~/.config/agent-hive/release-signing-key.pem`,
   and `HIVE_RELEASE_SKIP_ROOTFS=1` to skip building the rootfs (the bundle then records
   `ROOTFS_VERSION=none`). `HIVE_RELEASE_VERSION=<x.y.z or x.y.z-dev.n>` overrides
   `package.json`'s version (the dev workflow uses it), and
   `HIVE_RELEASE_REUSE_ROOTFS=<path to hive-rootfs-<rver>-linux-x86_64.tar.gz>` reuses a rootfs an
   earlier release built instead of running podman: the file's name gives the rootfs version, and a
   `rootfs-info.json` next to it (which every built rootfs release has) is copied into the output.

   The build also runs `scripts/build-native.sh` for libkrun, libkrunfw and the launcher (podman
   and network; see above), and downloads the GPL source assets described below.

   **Security updates in the VM:** the image's packages (Fedora, Chromium, Node, git) aren't
   pinned, but podman's layer cache keeps the old ones, so a plain release reuses the previous
   rootfs. Set `HIVE_RELEASE_FRESH_ROOTFS=1` to rebuild it without the cache and with a freshly
   pulled base image. That gives a new rootfs version, which every user downloads again (about
   660 MB), so do it for Chromium or Fedora security fixes and at least monthly, not for every
   app-only release. Say in the release notes when the rootfs changed.

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

## Automation and the dev channel

`.github/workflows/` keeps `main` at the newest upstream pins and publishes a signed dev
prerelease every day. Stable releases stay manual. The GitHub side is already set up: the
`beta-release` environment (kept under its old name) holding the `BETA_SIGNING_KEY` secret,
auto-merge enabled, and Actions allowed to create pull requests.

### Two signing keys

- **Stable key** (`RELEASE_PUBLIC_KEY` in `src/release-key.ts`): its private half lives only on the
  release machine (see above) and never in GitHub.
- **Prerelease key** (`PRERELEASE_PUBLIC_KEY` in `src/release-key.ts`): its private half, an ed25519
  PKCS#8 PEM, is the `BETA_SIGNING_KEY` secret of the `beta-release` environment. The dev workflow
  signs each dev prerelease with it in CI.

A stable install trusts only the stable key, so the prerelease key (or a GitHub compromise) cannot
sign an update for it. The dev channel trusts both keys, so a dev install can move back to a stable
release.

**Rotating the prerelease key:** generate a new keypair with `node scripts/keygen.mjs <file>`, put
the private half in the `BETA_SIGNING_KEY` environment secret, commit the new public half as
`PRERELEASE_PUBLIC_KEY`, and publish the next dev build. The stable key is untouched; existing dev
installs keep trusting the previous prerelease key until they update.

### Branches and pull requests

- `main` is the only branch. Every change — yours, the daily update check's pull requests,
  Dependabot's — lands on `main` through a pull request that merges automatically once the required
  `test` and `vm` checks pass.
- Dependabot's updates, major versions included, merge once CI passes, like the daily check's.
- Pull requests opened with `GITHUB_TOKEN` don't start workflows on their own, so the bump workflow
  dispatches `ci.yml` on its branch before enabling auto-merge; that run's checks land on the same
  commit.
- The maintainer sets `main` branch protection: required checks `test` and `vm`, auto-merge
  allowed.

### The daily bump check

`scripts/check-updates.mjs` (`bump.yml`, daily at 04:23 UTC) reads `versions.json` and
`image/Containerfile` and asks each upstream for its newest release:

| Component | Source |
|---|---|
| libkrun | `containers/libkrun`'s latest GitHub release; the commit from `git ls-remote` |
| libkrunfw | `containers/libkrunfw`'s latest GitHub release and its `libkrunfw-x86_64.tgz` |
| passt | `git ls-remote --tags https://passt.top/passt`, newest dated tag, snapshot tarball |
| rust | `static.rust-lang.org/dist/channel-rust-stable.toml` |
| buildImage | the `manylinux_2_28_x86_64` `latest` tag on quay.io |
| node | nodejs.org's index, newest release of the pinned major |
| pi | `@earendil-works/pi-coding-agent` on npm |

For each update it creates the branch `auto/<component>-<version>`, applies the bump with
`--apply`, commits as `github-actions[bot]`, pushes, and opens a pull request against `main` with
the old → new version and the source URL. `--list` prints the updates as JSON, which the workflow
reads.

### The daily dev prerelease

`dev.yml` (daily at 05:41 UTC, or `workflow_dispatch` with `fresh_rootfs`) builds and publishes
`v<package.json patch + 1>-dev.<run number>` when `main` has moved since the last dev tag or the
rootfs needs rebuilding:

- `plan` compares `main`'s HEAD with the newest `v*-dev.*` tag (the old `v*-beta.*` tags count as
  previous prereleases too), finds the newest release that carries a `rootfs-info.json`, and reuses
  its rootfs unless the rule below says to rebuild.
- `release` (the `beta-release` environment) builds with `HIVE_RELEASE_VERSION`, signs with
  `BETA_SIGNING_KEY`, verifies `SHA256SUMS.sig` against `PRERELEASE_PUBLIC_KEY`, boots a real VM
  (`scripts/vm-smoke.mjs`), and only then publishes the prerelease: the commits since the previous
  prerelease tag, which rootfs it uses, and `hive update --channel dev`.

The rootfs rule (`scripts/rootfs-plan.mjs`) reuses the tested rootfs unless

- the `image/` tree changed,
- the rootfs has pending security updates,
- it is 14 or more days old and has any pending updates,
- or the run was dispatched with `fresh_rootfs`.

A reuse copies the previous release's rootfs tarball and `rootfs-info.json` into the new release;
only a rebuild pays the ~660 MB rootfs build and download.

### Promotion to stable

1. Bump `version` in `package.json` and cut the stable release locally from `main`, as in "Cut a
   release". Optionally build from the exact commit of a dev build that has been good, with
   `HIVE_RELEASE_REUSE_ROOTFS=<that build's rootfs tarball>` set to ship exactly the rootfs the dev
   build already tested; otherwise the release rebuilds it.
2. Publish with `gh release create` as before. Stable installs accept only the stable key.

## What each file is

| File | What |
|------|------|
| `release/<version>/hive-<version>-linux-x86_64.tar.gz` | The app bundle: `bin/hive` (a `sh` wrapper), `lib/hive.mjs` (the CLI as one esbuild file), `lib/libkrun.so.1` and `lib/libkrunfw.so.5` (the old-glibc native pieces, with `RUNPATH=$ORIGIN`), `libexec/node` (bundled Node), `libexec/hive-vm` (hardened launcher), `libexec/pasta` (the static pasta fallback), `share/licenses/` (libkrun, libkrunfw, passt and hive's own MIT license), `VERSION`, `ROOTFS_VERSION`. |
| `release/<version>/hive-rootfs-<rootfs-version>-linux-x86_64.tar.gz` | The VM root filesystem, extracted under `~/.local/share/agent-hive/rootfs/<rootfs-version>`. A new download is only needed when the rootfs version changes. |
| `release/<version>/libkrunfw-<version>-source.tar.gz` | libkrunfw's source at the pinned tag (GPL/LGPL corresponding source). |
| `release/<version>/kernel-source-<file>` | The kernel tarball libkrunfw's `Makefile` downloads (its `KERNEL_REMOTE`); with libkrunfw's source (config and patches) it is the GPL-2.0 corresponding source. |
| `release/<version>/passt-<version>-source.tar.xz` | The passt source tarball (GPL-2.0-or-later / BSD-3-Clause corresponding source) the static `pasta` was built from. |
| `release/<version>/SHA256SUMS` | SHA-256 of the app, the rootfs and the source tarballs. |
| `release/<version>/SHA256SUMS.sig` | Base64 ed25519 signature over `SHA256SUMS`, verified by `hive update`. |
| `release/<version>/rootfs-info.json` | Which rootfs this release ships (`rootfs`), the `image/` git tree it was built from (`imageTree`) and when it was built (`built`). Not in `SHA256SUMS` (clients never read it); the dev rootfs plan does. |

`install-cli.sh` checks the download against `SHA256SUMS` over HTTPS but does not verify the
signature; `hive update` checks both before switching versions.

Installers put versions under `~/.local/share/agent-hive/versions/<version>` and switch the
`current` symlink atomically, keeping `previous` for `hive update --rollback`.
