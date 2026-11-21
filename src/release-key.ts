/** ed25519 public key (SPKI PEM) that signs release SHA256SUMS files. Empty: updates can't be verified. */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAp+ybUUJZ5EXfhhi3BwKCXicLYBc56HUojzuFjTsZFkg=
-----END PUBLIC KEY-----
`;

/**
 * The beta channel's signing key. Beta prereleases are signed in CI with this key (its private half
 * is the `beta-release` environment secret); installs on the stable channel never accept it.
 */
export const BETA_RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWdnEWR0UkzDTAxMQCbeb4/klDgiRDcRruujT3WNdcEs=
-----END PUBLIC KEY-----
`;
