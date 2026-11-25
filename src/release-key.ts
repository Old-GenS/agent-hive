/**
 * Who may sign a release.
 *
 * Keyless: a signature counts only when its certificate names the workflow ref below, under this
 * issuer. There is no signing key to hold, lose or steal.
 */
import type { SigningIdentity } from "./verify-sigstore.js";

/** GitHub Actions mints the certificate; no other issuer is accepted. */
export const SIGSTORE_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * Signs releases: a manual run of the promote workflow on `main`. Signing happens at promotion,
 * not at build, so the certificate says "a tested build was promoted" rather than "something was
 * built and published in one step".
 */
export const RELEASE_SIGNING_IDENTITY =
  "https://github.com/Old-GenS/agent-hive/.github/workflows/promote.yml@refs/heads/main";

/** The identity a release must carry. */
export const RELEASE_IDENTITY: SigningIdentity = {
  issuer: SIGSTORE_ISSUER,
  identity: RELEASE_SIGNING_IDENTITY,
};
