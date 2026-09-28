import { env } from "../env.js"

const workspaceIdPattern = /^T[A-Z0-9]{1,63}$/
const userIdPattern = /^[UW][A-Z0-9]{1,63}$/

export type SlackAccountIdentity = { workspaceId: string; userId: string }

/** A deployment gate, never a customer-admin permission or distribution authorization. */
export function slackPreviewPolicyError(organizationId: string): { kind: "policy_blocked"; message: string } | null {
  if (
    env.slackEnabled === true
    && typeof organizationId === "string"
    && organizationId.startsWith("org_")
    && env.slackOrganizationId === organizationId
    && typeof env.slackWorkspaceId === "string"
    && workspaceIdPattern.test(env.slackWorkspaceId)
  ) return null
  return {
    kind: "policy_blocked",
    message: "Slack is limited to an approved internal validation workspace. An OpenWork administrator controls access to this preview.",
  }
}

/** Authorize the returned token's workspace, not the workspace hinted in the OAuth URL. */
export function slackWorkspaceAllowed(workspaceId: string): boolean {
  return env.slackEnabled === true
    && workspaceIdPattern.test(workspaceId)
    && workspaceId === env.slackWorkspaceId
}

export function encodeSlackAccountIdentity(identity: SlackAccountIdentity): string {
  if (!workspaceIdPattern.test(identity.workspaceId) || !userIdPattern.test(identity.userId)) {
    throw new Error("Slack returned an invalid account identity.")
  }
  return `slack:${identity.workspaceId}:${identity.userId}`
}

export function parseSlackAccountIdentity(value: string | null): SlackAccountIdentity | null {
  if (typeof value !== "string") return null
  const parts = value.split(":")
  if (parts.length !== 3 || parts[0] !== "slack") return null
  const workspaceId = parts[1]
  const userId = parts[2]
  if (!workspaceId || !userId || !workspaceIdPattern.test(workspaceId) || !userIdPattern.test(userId)) return null
  return { workspaceId, userId }
}
