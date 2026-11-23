/** ed25519 public key (SPKI PEM) that signs release SHA256SUMS files. Empty: updates can't be verified. */
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
