/**
 * Keyless release verification. A keyless release ships `SHA256SUMS.sigstore.json`, a sigstore
 * bundle: a short-lived certificate, a signature over SHA256SUMS and a transparency-log entry. The
 * certificate names the GitHub Actions workflow that produced it, so "signed by the release key"
 * becomes "signed by this workflow, in this repository, at this ref".
 *
 * The cryptography is sigstore's — chain to the Fulcio root, transparency-log inclusion,
 * certificate validity at signing time rather than at the reader's clock. What lives here is the
 * one question no library can answer: which identities count.
 */
import { verify } from "sigstore";

/** A workflow whose keyless signatures this build accepts. */
export interface SigningIdentity {
  /** The OIDC issuer that minted the certificate. */
  issuer: string;
  /** The certificate's URI SAN: `https://github.com/<owner>/<repo>/<workflow>@<ref>`. */
  identity: string;
}

/** The signature sidecar a keyless release ships: a sigstore bundle over `SHA256SUMS`. */
export const SIGNATURE_ASSET = "SHA256SUMS.sigstore.json";

/**
 * True when `bundleJson` signs exactly `payload` and its certificate names `identity`.
 *
 * Every failure is `false`, never a throw: a malformed bundle, different bytes, another
 * repository, another workflow, another ref, another issuer, no transparency-log entry. A check
 * that cannot be performed is never good enough — callers treat false as "do not install this".
 */
export async function verifySigstoreBundle(
  payload: Buffer,
  bundleJson: string,
  identity: SigningIdentity,
): Promise<boolean> {
  let bundle: unknown;
  try {
    bundle = JSON.parse(bundleJson);
  } catch {
    return false;
  }
  try {
    await verify(bundle as Parameters<typeof verify>[0], payload, {
      certificateIdentityURI: identity.identity,
      certificateIssuer: identity.issuer,
    });
    return true;
  } catch {
    return false;
  }
}
