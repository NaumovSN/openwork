import { env } from "../env.js"

const workspaceIdPattern = /^T[A-Z0-9]{1,63}$/
const userIdPattern = /^[UW][A-Z0-9]{1,63}$/

export type SlackAccountIdentity = { workspaceId: string; userId: string }

/** Operator-controlled Cloud rollout, independent of individual workspace consent. */
export function slackCloudPolicyError(): { kind: "policy_blocked"; message: string } | null {
  if (env.slackEnabled === true && env.orgMode === "multi_org") return null
  return {
    kind: "policy_blocked",
    message: "Native Slack is not enabled on this OpenWork Cloud deployment. An OpenWork administrator controls availability.",
  }
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
