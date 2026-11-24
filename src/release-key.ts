/**
 * Who may sign a release.
 *
 * Keyless: a signature counts only when its certificate names the workflow ref below, under this
 * issuer. There is no signing key to hold, lose or steal.
 *
 * `RELEASE_PUBLIC_KEY` is the ed25519 key older releases were signed with. It stays only so an
 * install can still verify a release that shipped `SHA256SUMS.sig`; nothing new is signed with it.
 */
import type { SigningIdentity } from "./verify-sigstore.js";

/** GitHub Actions mints the certificate; no other issuer is accepted. */
export const SIGSTORE_ISSUER = "https://token.actions.githubusercontent.com";

/** Signs releases: a manual run of the release workflow on `main`. */
export const RELEASE_SIGNING_IDENTITY =
  "https://github.com/Old-GenS/agent-hive/.github/workflows/release.yml@refs/heads/main";

/** The identity a release must carry. */
export const RELEASE_IDENTITY: SigningIdentity = {
  issuer: SIGSTORE_ISSUER,
  identity: RELEASE_SIGNING_IDENTITY,
};

/** ed25519 public key (SPKI PEM) used by releases that shipped `SHA256SUMS.sig`. */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAp+ybUUJZ5EXfhhi3BwKCXicLYBc56HUojzuFjTsZFkg=
-----END PUBLIC KEY-----
`;
