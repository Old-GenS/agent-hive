# Releasing Agent Hive

Releases are **signed**. `scripts/build-release.sh` produces an app bundle with a bundled
Node.js, the hardened VM launcher, libkrun and libkrunfw, plus the VM rootfs as a separate
download. Each release also uploads the GPL corresponding source of the kernel libkrunfw contains.
`SHA256SUMS` covers all of it and is signed by an ed25519 key that lives only on the release
machine.

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
Debian 11+, RHEL/Alma/Rocky 8+, Mint, Fedora, Arch and WSL distros), and downloads upstream's
prebuilt libkrunfw, checking it against a pinned SHA-256. It needs podman and network; the first
build takes several minutes, and later runs reuse `build/native/` while `versions.json` and
`vm/hive-vm.c` are unchanged (`bash scripts/build-native.sh --force` rebuilds anyway). The
container refuses output that needs a newer glibc symbol or unexpected shared libraries.

Every pin — libkrun's tag and commit, libkrunfw's version, URL and SHA-256, the Rust toolchain, the
manylinux build image digest and the bundled Node version — lives in `versions.json`. Bumping one is
just editing that file; `scripts/build-native.sh` rebuilds when the file's hash changes.

**Test a real VM before shipping a libkrun or libkrunfw bump**, including DNS and HTTPS from inside
it: build checks and unit tests can't see a guest-kernel regression. libkrunfw 5.6.4 (November
2026) booted fine but broke DNS in the VM, so the pin stays on 5.6.2, the version Fedora ships,
until a newer one passes that check.

## Pinned versions

| Pin | Where it is used |
|-----|------------------|
| `libkrun` (tag, commit) | Built from source in `scripts/build-native.sh`; the commit is verified after cloning |
| `libkrunfw` (version, URL, SHA-256) | Upstream's prebuilt x86_64 tarball, downloaded and checked by `scripts/build-native.sh` |
| `rust` | The toolchain `scripts/native-in-container.sh` installs with rustup |
| `buildImage` | The `manylinux_2_28` image digest the native build runs in |
| `node` | The Node.js version bundled in the app (`HIVE_NODE_VERSION` still overrides it) |

## Cut a release

1. Bump `version` in `package.json`.
2. Build:

   ```bash
   npm run release
   ```

   Set `HIVE_SIGNING_KEY` to use a key other than `~/.config/agent-hive/release-signing-key.pem`,
   and `HIVE_RELEASE_SKIP_ROOTFS=1` to skip building the rootfs (the bundle then records
   `ROOTFS_VERSION=none`).

   The build also runs `scripts/build-native.sh` for libkrun, libkrunfw and the launcher (podman
   and network; see above), and downloads the GPL source assets described below.

   **Security updates in the VM:** the image's packages (Fedora, Chromium, Node, git) aren't
   pinned, but podman's layer cache keeps the old ones, so a plain release reuses the previous
   rootfs. Set `HIVE_RELEASE_FRESH_ROOTFS=1` to rebuild it without the cache and with a freshly
   pulled base image. That gives a new rootfs version, which every user downloads again (about
   660 MB), so do it for Chromium or Fedora security fixes and at least monthly, not for every
   app-only release. Say in the release notes when the rootfs changed.

   **GPL source:** libkrunfw contains the Linux kernel (GPL-2.0), so a release publishes the
   corresponding source too: libkrunfw's source at the pinned tag and the kernel tarball its
   `Makefile` builds from. `scripts/build-release.sh` downloads both into `release/<version>/`
   and lists them in `SHA256SUMS`. Set `HIVE_RELEASE_SKIP_SOURCES=1` to skip both.
3. Publish:

   ```bash
   gh release create v<version> release/<version>/* --title v<version> --notes "<notes>"
   ```

## What each file is

| File | What |
|------|------|
| `release/<version>/hive-<version>-linux-x86_64.tar.gz` | The app bundle: `bin/hive` (a `sh` wrapper), `lib/hive.mjs` (the CLI as one esbuild file), `lib/libkrun.so.1` and `lib/libkrunfw.so.5` (the old-glibc native pieces, with `RUNPATH=$ORIGIN`), `libexec/node` (bundled Node), `libexec/hive-vm` (hardened launcher), `share/licenses/` (libkrun, libkrunfw and hive's own MIT license), `VERSION`, `ROOTFS_VERSION`. |
| `release/<version>/hive-rootfs-<rootfs-version>-linux-x86_64.tar.gz` | The VM root filesystem, extracted under `~/.local/share/agent-hive/rootfs/<rootfs-version>`. A new download is only needed when the rootfs version changes. |
| `release/<version>/libkrunfw-<version>-source.tar.gz` | libkrunfw's source at the pinned tag (GPL/LGPL corresponding source). |
| `release/<version>/kernel-source-<file>` | The kernel tarball libkrunfw's `Makefile` downloads (its `KERNEL_REMOTE`); with libkrunfw's source (config and patches) it is the GPL-2.0 corresponding source. |
| `release/<version>/SHA256SUMS` | SHA-256 of the app, the rootfs and both source tarballs. |
| `release/<version>/SHA256SUMS.sig` | Base64 ed25519 signature over `SHA256SUMS`, verified by `hive update`. |

`install-cli.sh` checks the download against `SHA256SUMS` over HTTPS but does not verify the
signature; `hive update` checks both before switching versions.

Installers put versions under `~/.local/share/agent-hive/versions/<version>` and switch the
`current` symlink atomically, keeping `previous` for `hive update --rollback`.
