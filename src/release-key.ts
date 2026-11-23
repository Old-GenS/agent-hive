/**
 * Who may sign a release.
 *
 * Keyless (what stable releases will use): a signature counts only when its certificate names one
 * of the workflow refs below, under this issuer. There is no signing key to steal.
 *
 * The ed25519 keys below are what nightlies still use. They stay until
 * `nightly.yml` signs with OIDC too; `release-rootfs.mjs` reads them straight out of this file so
 * the promotion command and the CLI cannot drift apart.
 */
import type { SigningIdentity } from "./verify-sigstore.js";

/** GitHub Actions mints the certificate; no other issuer is accepted. */
export const SIGSTORE_ISSUER = "https://token.actions.githubusercontent.com";

/** Signs stable releases: a manual run of the release workflow on `main`. */
export const RELEASE_SIGNING_IDENTITY =
  "https://github.com/Old-GenS/agent-hive/.github/workflows/release.yml@refs/heads/main";

/** Signs the nightly prereleases. Stable installs never accept it. */
export const PRERELEASE_SIGNING_IDENTITY =
  "https://github.com/Old-GenS/agent-hive/.github/workflows/nightly.yml@refs/heads/main";

/** The identity a stable release must carry. */
export const RELEASE_IDENTITY: SigningIdentity = {
  issuer: SIGSTORE_ISSUER,
  identity: RELEASE_SIGNING_IDENTITY,
};

/** The identity a nightly prerelease must carry. */
export const PRERELEASE_IDENTITY: SigningIdentity = {
  issuer: SIGSTORE_ISSUER,
  identity: PRERELEASE_SIGNING_IDENTITY,
};

/** ed25519 public key (SPKI PEM) that signs nightly and promoted SHA256SUMS files in CI. */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAp+ybUUJZ5EXfhhi3BwKCXicLYBc56HUojzuFjTsZFkg=
-----END PUBLIC KEY-----
`;

/**
 * The prerelease key, which signs the daily nightly prereleases built in CI (its private half is
 * the `BETA_SIGNING_KEY` environment secret). Stable installs never accept it.
 */
export const PRERELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWdnEWR0UkzDTAxMQCbeb4/klDgiRDcRruujT3WNdcEs=
-----END PUBLIC KEY-----
`;
