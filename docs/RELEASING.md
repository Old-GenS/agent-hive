# Releasing Agent Hive

Releases are **signed**. `scripts/build-release.sh` produces an app bundle with a bundled
Node.js and the VM launcher, plus the VM rootfs as a separate download, and covers both with a
`SHA256SUMS` file signed by an ed25519 key that lives only on the release machine.

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

## Cut a release

1. Bump `version` in `package.json`.
2. Build:

   ```bash
   npm run release
   ```

   Set `HIVE_SIGNING_KEY` to use a key other than `~/.config/agent-hive/release-signing-key.pem`,
   and `HIVE_RELEASE_SKIP_ROOTFS=1` to skip building the rootfs (the bundle then records
   `ROOTFS_VERSION=none`).

   **Security updates in the VM:** the image's packages (Fedora, Chromium, Node, git) aren't
   pinned, but podman's layer cache keeps the old ones, so a plain release reuses the previous
   rootfs. Set `HIVE_RELEASE_FRESH_ROOTFS=1` to rebuild it without the cache and with a freshly
   pulled base image. That gives a new rootfs version, which every user downloads again (about
   660 MB), so do it for Chromium or Fedora security fixes and at least monthly, not for every
   app-only release. Say in the release notes when the rootfs changed.
3. Publish:

   ```bash
   gh release create v<version> release/<version>/* --title v<version> --notes "<notes>"
   ```

## What each file is

| File | What |
|------|------|
| `release/<version>/hive-<version>-linux-x86_64.tar.gz` | The app bundle: `bin/hive` (a `sh` wrapper), `lib/hive.mjs` (the CLI as one esbuild file), `libexec/node` (bundled Node), `libexec/hive-vm` (launcher), `VERSION`, `ROOTFS_VERSION`. |
| `release/<version>/hive-rootfs-<rootfs-version>-linux-x86_64.tar.gz` | The VM root filesystem, extracted under `~/.local/share/agent-hive/rootfs/<rootfs-version>`. A new download is only needed when the rootfs version changes. |
| `release/<version>/SHA256SUMS` | SHA-256 of the two tarballs. |
| `release/<version>/SHA256SUMS.sig` | Base64 ed25519 signature over `SHA256SUMS`, verified by `hive update`. |

`install-cli.sh` checks the download against `SHA256SUMS` over HTTPS but does not verify the
signature; `hive update` checks both before switching versions.

Installers put versions under `~/.local/share/agent-hive/versions/<version>` and switch the
`current` symlink atomically, keeping `previous` for `hive update --rollback`.
