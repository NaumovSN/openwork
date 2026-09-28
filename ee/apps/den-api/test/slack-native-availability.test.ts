import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConnectedAccountRow } from "../src/capability-sources/oauth-credentials.js"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const settings = {
  slackEnabled: true,
  slackOrganizationId: organizationId,
  slackWorkspaceId: "TVALIDATION",
  slackClientId: "synthetic-client",
  slackClientSecret: "synthetic-secret",
  mcpConnectionsGatingEnabled: false,
}
let connectEnabled = true
let account: ConnectedAccountRow | null = null

mock.module("../src/env.js", () => ({ env: settings }))
mock.module("../src/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ metadata: { capabilities: { mcpConnections: connectEnabled } } }],
        }),
      }),
    }),
  },
}))
mock.module("../src/capability-sources/oauth-credentials.js", () => ({
  getOrgOAuthClient: async () => null,
  getConnectedAccount: async () => account,
}))
mock.module("../src/capability-sources/external-mcp-connections.js", () => ({
  listExternalMcpConnections: async () => [],
  listUsableNativeProviderConnections: async () => [],
}))

const { listBlockedNativeProviderAccountEntries, listNativeProviderUsableEntries, resolveDefaultNativeProviderCredentialId } = await import("../src/capability-sources/native-provider-connections.js")

beforeEach(() => {
  settings.slackEnabled = true
  settings.slackOrganizationId = organizationId
  settings.slackWorkspaceId = "TVALIDATION"
  settings.slackClientId = "synthetic-client"
  settings.slackClientSecret = "synthetic-secret"
  connectEnabled = true
  account = null
})
afterAll(() => mock.restore())

const entriesForMember = () => listNativeProviderUsableEntries({ organizationId, orgMembershipId: memberId })

test("an enabled internal member gets a Slack connection without configuring an OAuth app", async () => {
  const entries = await entriesForMember()
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    id: "slack",
    nativeProviderKey: "slack",
    credentialMode: "per_member",
    connectedForMe: false,
    exposeDirectly: false,
  })
  expect(JSON.stringify(entries)).not.toContain("synthetic-secret")
  expect(JSON.stringify(entries)).not.toContain("synthetic-client")
})

function connectedSlackAccount(): ConnectedAccountRow {
  return {
    id: createDenTypeId("connectedAccount"),
    organizationId,
    orgMembershipId: memberId,
    providerId: "slack",
    externalAccountId: "slack:TVALIDATION:USYNTHETIC",
    accessToken: "synthetic-user-token",
    refreshToken: null,
    tokenType: "user",
    expiresAt: null,
    pendingCodeVerifier: null,
    credentialHealth: null,
    scopes: ["search:read.public", "channels:history"],
    connectedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  }
}

test("public-only consent remains connected and reports unavailable optional conversations", async () => {
  account = connectedSlackAccount()
  const entries = await entriesForMember()
  expect(entries[0]).toMatchObject({
    connectedForMe: true,
    needsReconnect: false,
    missingFeatures: ["privateChannels", "directMessages", "groupMessages"],
  })
})

test("disabling Slack blocks discovery and retained default-account selection", async () => {
  account = connectedSlackAccount()
  settings.slackEnabled = false
  expect(await entriesForMember()).toEqual([])
  expect(await resolveDefaultNativeProviderCredentialId({
    organizationId,
    orgMembershipId: memberId,
    nativeProviderKey: "slack",
    teamIds: [],
  })).toBeNull()
})

test("a disabled existing Slack account remains manageable but never usable by capabilities", async () => {
  account = connectedSlackAccount()
  settings.slackEnabled = false
  const managed = await listBlockedNativeProviderAccountEntries({ organizationId, orgMembershipId: memberId })
  expect(managed).toHaveLength(1)
  expect(managed[0]).toMatchObject({
    id: "slack", nativeProviderKey: "slack", connected: false, connectedForMe: true,
    policyBlocked: true, policyOwner: "openwork", needsReconnect: false,
  })
  expect(managed[0]?.policyMessage).toContain("OpenWork administrator")
  expect(JSON.stringify(managed)).not.toContain("synthetic-user-token")
  expect(await entriesForMember()).toEqual([])
})

test("management-only rows are not advertised to new members or borrowed across identities", async () => {
  settings.slackEnabled = false
  expect(await listBlockedNativeProviderAccountEntries({ organizationId, orgMembershipId: memberId })).toEqual([])
  account = connectedSlackAccount()
  expect(await listBlockedNativeProviderAccountEntries({ organizationId, orgMembershipId: createDenTypeId("member") })).toEqual([])
  expect(await listBlockedNativeProviderAccountEntries({ organizationId: createDenTypeId("organization"), orgMembershipId: memberId })).toEqual([])
})

test("management keeps stale-workspace and unavailable-app grants visible only for cleanup", async () => {
  account = { ...connectedSlackAccount(), externalAccountId: "slack:TOTHER:USYNTHETIC" }
  expect((await listBlockedNativeProviderAccountEntries({ organizationId, orgMembershipId: memberId }))[0]).toMatchObject({ policyBlocked: true, connectedForMe: true })
  account = connectedSlackAccount()
  settings.slackClientSecret = ""
  expect((await listBlockedNativeProviderAccountEntries({ organizationId, orgMembershipId: memberId }))[0]).toMatchObject({ policyBlocked: true, connectedForMe: true })
})

test("an account for another Slack workspace is not shown as connected", async () => {
  account = { ...connectedSlackAccount(), externalAccountId: "slack:TOTHER:USYNTHETIC" }
  const entries = await entriesForMember()
  expect(entries[0]?.connectedForMe).toBe(false)
  expect(entries[0]?.externalAccountId).toBeUndefined()
})

test("an external organization never receives the internal platform app", async () => {
  expect(await listNativeProviderUsableEntries({
    organizationId: createDenTypeId("organization"),
    orgMembershipId: memberId,
  })).toEqual([])
})

test("missing workspace approval, missing credentials, and disabled Connect all fail closed", async () => {
  settings.slackWorkspaceId = ""
  expect(await entriesForMember()).toEqual([])
  settings.slackWorkspaceId = "TVALIDATION"
  settings.slackClientSecret = ""
  expect(await entriesForMember()).toEqual([])
  settings.slackClientSecret = "synthetic-secret"
  connectEnabled = false
  expect(await entriesForMember()).toEqual([])
})

test("missing required public permissions require reconnect rather than inventing grants", async () => {
  account = { ...connectedSlackAccount(), scopes: [] }
  const entries = await entriesForMember()
  expect(entries[0]?.needsReconnect).toBe(true)
  expect(entries[0]?.grantedScopes).toEqual([])
})
