import { createHmac } from "node:crypto"

/**
 * Domain-separated lookup tag for free Auto identities and credentials.
 *
 * Free credentials (`ow_auto_…`) are CSPRNG-generated 256-bit keys, not
 * passwords, so a keyed SHA-256 tag is the lookup primitive, matching the
 * Gateway bearer-key store. Den and the Gateway must derive the same tag.
 */
const FREE_INFERENCE_DIGEST_DOMAIN = "openwork-free-inference-digest-v1"

export function freeInferenceDigest(kind: string, value: string): string {
  return createHmac("sha256", FREE_INFERENCE_DIGEST_DOMAIN).update(`${kind}:${value}`).digest("hex")
}
