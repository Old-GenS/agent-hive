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

## Cut a release

1. Bump `version` in `package.json`.
2. Build:

   ```bash
   npm run release
   ```

   Set `HIVE_SIGNING_KEY` to use a key other than `~/.config/agent-hive/release-signing-key.pem`,
   and `HIVE_RELEASE_SKIP_ROOTFS=1` to skip building the rootfs (the bundle then records
   `ROOTFS_VERSION=none`).
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
