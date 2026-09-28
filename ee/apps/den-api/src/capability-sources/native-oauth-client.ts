import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import { getOrgOAuthClient, type OrgOAuthClientRow } from "./oauth-credentials.js"
import { slackPreviewPolicyError } from "./slack-preview.js"

/** The native OAuth driver needs registration data, not a persisted row or a fabricated row ID. */
export type NativeOAuthClient = Pick<OrgOAuthClientRow, "clientId" | "clientSecret" | "extra">

export async function getNativeOAuthClient(
  organizationId: DenTypeId<"organization">,
  credentialProviderId: string,
): Promise<NativeOAuthClient | null> {
  if (credentialProviderId !== "slack") return getOrgOAuthClient(organizationId, credentialProviderId)
  // The new native preview is platform-managed. The existing Slack MCP/BYO
  // registrations use their own emc_ identities and are deliberately untouched.
  if (slackPreviewPolicyError(organizationId) || !env.slackClientId || !env.slackClientSecret) return null
  return {
    clientId: env.slackClientId,
    clientSecret: env.slackClientSecret,
    extra: { features: ["privateChannels", "directMessages", "groupMessages"] },
  }
}
