import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"
import { z } from "zod"

// The only substitute is the storage boundary. OAuth routes, middleware,
// credential CAS, policy, and provider HTTP handling run their real code.
process.env.DATABASE_URL = "mysql://unused:unused@127.0.0.1:1/slack_oauth_test"
process.env.DEN_DB_ENCRYPTION_KEY = "x".repeat(32)
process.env.BETTER_AUTH_SECRET = "y".repeat(32)
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
const schema = await import("@openwork-ee/den-db/schema")
const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const secondMemberId = createDenTypeId("member")
const secondUserId = createDenTypeId("user")
const otherOrganizationId = createDenTypeId("organization")
const now = new Date()
let callerOrganizationId = organizationId
let callerUserId = userId
let rows = new Map<unknown, Record<string, unknown>[]>()

function conditionValues(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return []
  if ("queryChunks" in value && Array.isArray(value.queryChunks)) return value.queryChunks.flatMap(conditionValues)
  if ("value" in value && !Array.isArray(value.value)) return [value.value]
  return []
}
function matches(row: Record<string, unknown>, condition: unknown) {
  return conditionValues(condition).every((value) => Object.values(row).includes(value))
}
const storage = {
  select() {
    return {
      from(table: unknown) {
        let condition: unknown
        let joined = false
        let maximum = Infinity
        const result = () => (joined ? [] : rows.get(table) ?? [])
          .filter((row) => matches(row, condition)).slice(0, maximum).map((row) => ({ ...row }))
        const query = {
          where(value: unknown) { condition = value; return query },
          limit(count: number) { maximum = count; return query },
          orderBy() { return query },
          innerJoin() { joined = true; return query },
          leftJoin() { joined = true; return query },
          for() { return query },
          async execute() { return result() },
          then(resolve: (value: Record<string, unknown>[]) => unknown) { return Promise.resolve(result()).then(resolve) },
        }
        return query
      },
    }
  },
  selectDistinct() { return storage.select() },
  insert(table: unknown) {
    return {
      values(value: Record<string, unknown>) {
        const run = async () => {
          const existing = rows.get(table) ?? []
          existing.push({ createdAt: now, updatedAt: now, connectedAt: now, ...value })
          rows.set(table, existing)
          return [{ insertId: value.id }]
        }
        return { execute: run, then(resolve: (value: unknown) => unknown) { return run().then(resolve) } }
      },
    }
  },
  update(table: unknown) {
    return {
      set(value: Record<string, unknown>) {
        return { async where(condition: unknown) {
          for (const row of rows.get(table) ?? []) if (matches(row, condition)) Object.assign(row, value)
        } }
      },
    }
  },
  delete(table: unknown) {
    return { async where(condition: unknown) {
      rows.set(table, (rows.get(table) ?? []).filter((row) => !matches(row, condition)))
    } }
  },
}
mock.module("../src/db.js", () => ({ db: {
  ...storage,
  async transaction<T>(run: (transaction: typeof storage) => Promise<T>): Promise<T> { return run(storage) },
} }))
let tokenBody: unknown
let identityBody: unknown
let tokenRequests = 0
let tokenRequestParams: URLSearchParams[] = []
let identityRequests = 0
let identityAuthorization: string | null = null
let identityResponse: (() => Promise<Response>) | undefined
let onTokenRequest: (() => Promise<void>) | undefined
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/api/oauth.v2.access") {
      tokenRequests++
      const responseBody = tokenBody
      tokenRequestParams.push(new URLSearchParams(await request.text()))
      await onTokenRequest?.()
      return Response.json(responseBody)
    }
    if (path === "/api/auth.test") {
      identityRequests++
      identityAuthorization = request.headers.get("authorization")
      return identityResponse ? identityResponse() : Response.json(identityBody)
    }
    return new Response("Not found", { status: 404 })
  },
})
let app: Hono<{ Variables: OrgRouteVariables & RequestIdVariables }>
let env: typeof import("../src/env.js").env
let oauth: typeof import("../src/capability-sources/generic-oauth.js")
const statusSchema = z.object({ connected: z.boolean(), externalAccountId: z.string().nullable(), scopes: z.array(z.string()).nullable() })

beforeAll(async () => {
  env = (await import("../src/env.js")).env
  Object.assign(env, {
    slackEnabled: true, slackOrganizationId: organizationId, slackWorkspaceId: "TTEST001",
    slackClientId: "synthetic-client", slackClientSecret: "synthetic-secret",
    slackApiBaseUrl: `${server.url.origin}/api`,
  })
  const registry = await import("../src/capability-sources/provider-registry.js")
  registry.NATIVE_OAUTH_PROVIDERS.slack = {
    providerId: "slack", displayName: "Slack", websiteUrl: "https://slack.com",
    authorizeUrl: `${server.url.origin}/oauth/v2/authorize`, tokenUrl: `${server.url.origin}/api/oauth.v2.access`,
    usesPkce: false, defaultScopes: ["search:read.public", "channels:history"],
    defaultFeatures: ["privateChannels", "directMessages", "groupMessages"],
    optionalFeatures: {
      privateChannels: ["search:read.private", "groups:history"],
      directMessages: ["search:read.im", "im:history"],
      groupMessages: ["search:read.mpim", "mpim:history"],
    },
  }
  const { registerOAuthProviderRoutes } = await import("../src/routes/org/oauth-providers.js")
  oauth = await import("../src/capability-sources/generic-oauth.js")
  app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", { id: callerUserId, name: "Synthetic member", email: "member@example.test", emailVerified: true, image: null, createdAt: now, updatedAt: now })
    c.set("session", {
      id: "synthetic-session", token: "synthetic-session-token", userId: callerUserId,
      createdAt: new Date(), updatedAt: now, expiresAt: new Date(Date.now() + 3_600_000),
      activeOrganizationId: callerOrganizationId, activeTeamId: null, ipAddress: null, userAgent: null,
    })
    c.set("activeOrganizationId", callerOrganizationId)
    c.set("requestId", "synthetic-request")
    await next()
  })
  registerOAuthProviderRoutes(app)
})
beforeEach(() => {
  callerOrganizationId = organizationId
  callerUserId = userId
  Object.assign(env, {
    slackEnabled: true, slackOrganizationId: organizationId, slackWorkspaceId: "TTEST001",
    slackClientId: "synthetic-client", slackClientSecret: "synthetic-secret",
  })
  rows = new Map<unknown, Record<string, unknown>[]>([
    [schema.OrganizationTable, [organizationId, otherOrganizationId].map((id) => ({
      id, name: "Synthetic workspace", slug: id, metadata: {}, allowedEmailDomains: [], createdAt: now, updatedAt: now,
    }))],
    [schema.MemberTable, [
      ...[organizationId, otherOrganizationId].map((id) => ({
        id: id === organizationId ? memberId : createDenTypeId("member"),
        organizationId: id, userId, role: "owner", removedAt: null, createdAt: now, joinedAt: now,
      })),
      { id: secondMemberId, organizationId, userId: secondUserId, role: "member", removedAt: null, createdAt: now, joinedAt: now },
    ]],
  ])
  tokenRequests = 0
  tokenRequestParams = []
  identityRequests = 0
  identityAuthorization = null
  identityResponse = undefined
  onTokenRequest = undefined
  tokenBody = {
    ok: true, access_token: "synthetic-bot-token", scope: "chat:write", token_type: "bot",
    team: { id: "TTEST001" }, is_enterprise_install: false,
    authed_user: { id: "UTEST001", token_type: "user", access_token: "synthetic-member-token", scope: "search:read.public,channels:history" },
  }
  identityBody = { ok: true, team_id: "TTEST001", user_id: "UTEST001", is_enterprise_install: false }
})
afterAll(() => { server.stop(true); mock.restore() })

function request(path: string, method = "GET", body?: unknown) {
  return app.request(`http://den.example.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
}
async function start(path = "/v1/oauth-providers/slack/connect/start") {
  const response = await request(path)
  expect(response.status).toBe(200)
  return new URL(z.object({ authorizeUrl: z.string() }).parse(await response.json()).authorizeUrl)
}
async function callback(authorize: URL) {
  const state = authorize.searchParams.get("state")
  if (!state) throw new Error("Authorization omitted state")
  return request(`/v1/oauth-providers/slack/connect/callback?code=synthetic-code&state=${encodeURIComponent(state)}`)
}
async function status() {
  const response = await request("/v1/oauth-providers/slack/status")
  expect(response.status).toBe(200)
  return statusSchema.parse(await response.json())
}

async function nativeToken(credentialProviderId = "slack", orgId = organizationId, membershipId = memberId) {
  const registry = await import("../src/capability-sources/provider-registry.js")
  const provider = registry.getNativeOAuthProvider("slack")
  if (!provider) throw new Error("Slack missing")
  return oauth.getValidAccessToken({ provider, credentialProviderId, organizationId: orgId, orgMembershipId: membershipId })
}

async function connectExpiringGrant(scope = "search:read.public,channels:history,search:read.private,groups:history") {
  tokenBody = {
    ok: true, team: { id: "TTEST001" }, authed_user: {
      id: "UTEST001", token_type: "user", access_token: "expiring-member-token", refresh_token: "synthetic-refresh",
      expires_in: 1, scope,
    },
  }
  expect((await callback(await start())).status).toBe(200)
}

test("the organization Connect policy blocks both Slack start aliases and pending callbacks", async () => {
  const authorize = await start()
  const organization = rows.get(schema.OrganizationTable)?.find((row) => row.id === organizationId)
  if (!organization) throw new Error("Missing synthetic organization")
  organization.metadata = { capabilities: { mcpConnections: false } }
  expect((await request("/v1/oauth-providers/slack/connect/start")).status).toBe(403)
  expect((await request("/v1/mcp-connections/slack/connect/start")).status).toBe(403)
  expect((await callback(authorize)).status).toBe(403)
  expect(tokenRequests).toBe(0)
})

test("disabling organization Connect during exchange prevents saving the new Slack grant", async () => {
  const authorize = await start()
  const organization = rows.get(schema.OrganizationTable)?.find((row) => row.id === organizationId)
  if (!organization) throw new Error("Missing synthetic organization")
  onTokenRequest = async () => { organization.metadata = { capabilities: { mcpConnections: false } } }
  expect((await callback(authorize)).status).toBe(400)
  organization.metadata = {}
  expect((await status()).connected).toBe(false)
})

test("connected Slack accounts are isolated between OpenWork members", async () => {
  expect((await callback(await start())).status).toBe(200)
  callerUserId = secondUserId
  expect((await status()).connected).toBe(false)
  tokenBody = { ok: true, team: { id: "TTEST001" }, authed_user: { id: "UOTHER001", token_type: "user", access_token: "second-member-token", scope: "search:read.public" } }
  identityBody = { ok: true, team_id: "TTEST001", user_id: "UOTHER001" }
  expect((await callback(await start())).status).toBe(200)
  expect((await status()).externalAccountId).toBe("slack:TTEST001:UOTHER001")
  callerUserId = userId
  expect((await status()).externalAccountId).toBe("slack:TTEST001:UTEST001")
  expect((await request("/v1/oauth-providers/slack/disconnect", "POST")).status).toBe(200)
  callerUserId = secondUserId
  expect((await status()).connected).toBe(true)
})

test("a zero-lifetime Slack token is expired rather than treated as permanent", async () => {
  tokenBody = { ok: true, team: { id: "TTEST001" }, authed_user: {
    id: "UTEST001", token_type: "user", access_token: "already-expired", refresh_token: "synthetic-refresh",
    expires_in: 0, scope: "search:read.public,channels:history",
  } }
  expect((await callback(await start())).status).toBe(200)
  tokenBody = {
    ok: true, id: "UTEST001", token_type: "user", access_token: "fresh-member-token",
    refresh_token: "rotated-refresh", expires_in: 3600, scope: "search:read.public,channels:history",
  }
  const refreshed = await nativeToken()
  expect("accessToken" in refreshed && refreshed.accessToken).toBe("fresh-member-token")
  expect(tokenRequests).toBe(2)
})

const validUserRefreshReply = {
  ok: true, token_type: "user", access_token: "refreshed-user-token",
  refresh_token: "rotated-refresh", expires_in: 43200,
}

test.each([
  { ...validUserRefreshReply, ok: false },
  { ...validUserRefreshReply, token_type: "bot", authed_user: { access_token: "nested-user-decoy", token_type: "user" } },
  { ...validUserRefreshReply, token_type: undefined },
  { ...validUserRefreshReply, access_token: "" },
  { ...validUserRefreshReply, access_token: undefined, authed_user: { access_token: "nested-user-decoy", token_type: "user" } },
  { ...validUserRefreshReply, refresh_token: undefined },
  { ...validUserRefreshReply, expires_in: undefined },
  { ...validUserRefreshReply, scope: null },
  { ...validUserRefreshReply, is_enterprise_install: true },
])("refresh rejects invalid top-level grants rather than substituting nested tokens (%#)", async (reply) => {
  await connectExpiringGrant()
  tokenBody = reply
  await expect(nativeToken()).rejects.toBeInstanceOf(oauth.OAuthTokenExchangeError)
  expect(identityRequests).toBe(1)
  expect((await status()).scopes).toEqual(["search:read.public", "channels:history", "search:read.private", "groups:history"])
})

test("refresh selects the top-level user grant even when the response also contains a nested token", async () => {
  await connectExpiringGrant()
  tokenBody = {
    ...validUserRefreshReply, scope: "search:read.public,channels:history",
    authed_user: { id: "UOTHER001", access_token: "nested-token-decoy", token_type: "user", scope: "search:read.private" },
  }
  const refreshed = await nativeToken()
  expect("accessToken" in refreshed && refreshed.accessToken).toBe("refreshed-user-token")
  expect(identityAuthorization).toBe("Bearer refreshed-user-token")
  expect(tokenRequestParams[1]?.get("grant_type")).toBe("refresh_token")
  expect(tokenRequestParams[1]?.get("refresh_token")).toBe("synthetic-refresh")
  expect(tokenRequestParams[1]?.has("code")).toBe(false)
  expect((await status()).scopes).toEqual(["search:read.public", "channels:history"])
})

test("an explicitly empty refreshed scope removes grants instead of preserving stale permissions", async () => {
  await connectExpiringGrant()
  tokenBody = { ...validUserRefreshReply, scope: "" }
  const refreshed = await nativeToken()
  expect("accessToken" in refreshed && refreshed.accessToken).toBe("refreshed-user-token")
  expect((await status()).scopes).toEqual([])
})

test("an omitted refresh scope cannot manufacture grants when none were previously confirmed", async () => {
  await connectExpiringGrant("")
  tokenBody = validUserRefreshReply
  const refreshed = await nativeToken()
  expect("accessToken" in refreshed && refreshed.accessToken).toBe("refreshed-user-token")
  expect((await status()).scopes).toEqual([])
})

test("a refresh omitting scope and identity hints preserves only the previously confirmed partial grant", async () => {
  await connectExpiringGrant("search:read.public,channels:history")
  tokenBody = {
    ok: true, token_type: "user", access_token: "refreshed-partial-token",
    refresh_token: "rotated-refresh", expires_in: 43200,
  }
  const refreshed = await nativeToken()
  expect("accessToken" in refreshed && refreshed.accessToken).toBe("refreshed-partial-token")
  expect(identityAuthorization).toBe("Bearer refreshed-partial-token")
  expect(await status()).toEqual({
    connected: true, externalAccountId: "slack:TTEST001:UTEST001", scopes: ["search:read.public", "channels:history"],
  })
})

test("two refreshes accepted during Slack's grace period reuse the CAS winner and its rotated refresh token", async () => {
  await connectExpiringGrant()
  let releaseFirst = () => {}
  let firstRequested = () => {}
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })
  const firstRequestStarted = new Promise<void>((resolve) => { firstRequested = resolve })
  tokenBody = {
    ...validUserRefreshReply, access_token: "late-grace-token", refresh_token: "late-grace-refresh",
    scope: "search:read.public,channels:history,search:read.private,groups:history",
  }
  onTokenRequest = async () => {
    if (tokenRequests === 2) { firstRequested(); await holdFirst }
  }
  const firstRefresh = nativeToken()
  await firstRequestStarted
  try {
    tokenBody = {
      ...validUserRefreshReply, access_token: "winning-grace-token", refresh_token: "winning-grace-refresh",
      scope: "search:read.public,channels:history",
    }
    const winner = await nativeToken()
    expect("accessToken" in winner && winner.accessToken).toBe("winning-grace-token")
  } finally {
    releaseFirst()
  }
  const late = await firstRefresh
  expect("accessToken" in late && late.accessToken).toBe("winning-grace-token")
  expect(tokenRequestParams.slice(1).map((params) => params.get("refresh_token"))).toEqual(["synthetic-refresh", "synthetic-refresh"])

  // Once the winner expires, the next outbound request must use its rotated
  // refresh token, not the old or losing grant. No wall-clock sleep is needed.
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 43_200_000)
  try {
    tokenBody = { ...validUserRefreshReply, access_token: "next-rotation-token", refresh_token: "next-rotation-refresh" }
    const next = await nativeToken()
    expect("accessToken" in next && next.accessToken).toBe("next-rotation-token")
    expect(tokenRequestParams[3]?.get("grant_type")).toBe("refresh_token")
    expect(tokenRequestParams[3]?.get("refresh_token")).toBe("winning-grace-refresh")
    expect((await status()).scopes).toEqual(["search:read.public", "channels:history"])
  } finally {
    clock.mockRestore()
  }
})

test("refresh cannot change the Slack member even when OAuth and auth.test agree on a different identity", async () => {
  await connectExpiringGrant()
  tokenBody = {
    ok: true, id: "UOTHER001", token_type: "user", access_token: "wrong-member-token",
    refresh_token: "rotated-refresh", expires_in: 3600, scope: "search:read.public",
  }
  identityBody = { ok: true, team_id: "TTEST001", user_id: "UOTHER001" }
  await expect(nativeToken()).rejects.toBeInstanceOf(oauth.OAuthTokenExchangeError)
  expect((await status()).externalAccountId).toBe("slack:TTEST001:UTEST001")
})

test("refresh is blocked before contacting Slack after disable and cannot restore a disconnected account", async () => {
  await connectExpiringGrant()
  Object.assign(env, { slackEnabled: false })
  expect(await nativeToken()).toEqual({ error: "not_connected" })
  expect(tokenRequests).toBe(1)
  Object.assign(env, { slackEnabled: true })
  tokenBody = {
    ok: true, id: "UTEST001", token_type: "user", access_token: "refreshed-token",
    refresh_token: "rotated-refresh", expires_in: 3600, scope: "search:read.public,channels:history",
  }
  onTokenRequest = async () => { expect((await request("/v1/oauth-providers/slack/disconnect", "POST")).status).toBe(200) }
  expect(await nativeToken()).toEqual({ error: "not_connected" })
  expect((await status()).connected).toBe(false)
})

test("a losing refresh does not switch to a newly connected Slack identity", async () => {
  await connectExpiringGrant()
  tokenBody = {
    ok: true, id: "UTEST001", token_type: "user", access_token: "late-refreshed-token",
    refresh_token: "rotated-refresh", expires_in: 3600, scope: "search:read.public,channels:history",
  }
  onTokenRequest = async () => {
    onTokenRequest = undefined
    tokenBody = { ok: true, team: { id: "TTEST001" }, authed_user: {
      id: "UOTHER001", token_type: "user", access_token: "new-connected-member", scope: "search:read.public,channels:history",
    } }
    identityBody = { ok: true, team_id: "TTEST001", user_id: "UOTHER001" }
    expect((await callback(await start())).status).toBe(200)
    identityBody = { ok: true, team_id: "TTEST001", user_id: "UTEST001" }
  }
  expect(await nativeToken()).toEqual({ error: "not_connected" })
  expect((await status()).externalAccountId).toBe("slack:TTEST001:UOTHER001")
})

test("refresh rechecks platform configuration before saving changed scopes", async () => {
  await connectExpiringGrant()
  tokenBody = {
    ok: true, id: "UTEST001", token_type: "user", access_token: "refreshed-token",
    refresh_token: "rotated-refresh", expires_in: 3600, scope: "search:read.public",
  }
  onTokenRequest = async () => { Object.assign(env, { slackClientId: "rotated-client" }) }
  expect(await nativeToken()).toEqual({ error: "not_connected" })
  expect((await status()).scopes).toEqual(["search:read.public", "channels:history", "search:read.private", "groups:history"])
})

test("identity verification times out without saving a connection", async () => {
  identityResponse = () => new Promise<Response>(() => {})
  expect((await callback(await start())).status).toBe(400)
  expect((await status()).connected).toBe(false)
}, 8_000)

test.each([
  { ok: false, error: "synthetic-sensitive-content" },
  { ok: true, team_id: "TOTHER001", user_id: "UTEST001" },
  { ok: true, team_id: "TTEST001", user_id: "UOTHER001" },
  { ok: true, team_id: "TTEST001", user_id: "invalid" },
  { ok: true, team_id: "TTEST001", user_id: "UTEST001", is_enterprise_install: true },
  { ok: true, team_id: "TTEST001", user_id: "UTEST001", bot_id: "BTEST001" },
  { ok: true, team_id: "TTEST001", user_id: "UTEST001", padding: "x".repeat(65_537) },
])("callback refuses unverified, mismatched, enterprise-wide, bot, or oversized identities (%#)", async (body) => {
  identityBody = body
  const response = await callback(await start())
  expect(response.status).toBe(400)
  expect(await response.text()).not.toContain("synthetic-sensitive-content")
  expect((await status()).connected).toBe(false)
})

test("missing granted scopes never become the requested optional permissions", async () => {
  tokenBody = { ok: true, team: { id: "TTEST001" }, authed_user: { id: "UTEST001", token_type: "user", access_token: "member-without-grants" } }
  expect((await callback(await start())).status).toBe(200)
  expect((await status()).scopes).toEqual([])
})

test("an unapproved organization cannot start, inspect, configure, or refresh native Slack", async () => {
  callerOrganizationId = otherOrganizationId
  for (const path of ["/v1/oauth-providers/slack/connect/start", "/v1/mcp-connections/slack/connect/start", "/v1/oauth-providers/slack/status", "/v1/oauth-providers/slack/client"]) {
    expect((await request(path)).status).toBe(403)
  }
  expect((await request("/v1/oauth-providers/slack/client", "POST", { clientId: "alternate" })).status).toBe(403)
  expect(await nativeToken("slack", otherOrganizationId)).toEqual({ error: "not_connected" })
  expect(tokenRequests).toBe(0)
})

test("missing platform credentials do not ask a member to create or configure a Slack app", async () => {
  Object.assign(env, { slackClientSecret: undefined })
  for (const path of ["/v1/oauth-providers/slack/connect/start", "/v1/mcp-connections/slack/connect/start"]) {
    const response = await request(path)
    expect(response.status).toBe(404)
    const body = z.object({ error: z.string(), message: z.string() }).parse(await response.json())
    expect(body.error).toBe("client_not_configured")
    expect(body.message).toContain("OpenWork-supplied Slack app")
  }
})

test("native Slack ignores organization app overrides and rejects alternate credential IDs", async () => {
  const alternateId = createDenTypeId("externalMcpConnection")
  rows.set(schema.ExternalMcpConnectionTable, [{ id: alternateId, organizationId, kind: "native_provider", nativeProviderKey: "slack" }])
  rows.set(schema.OrgOAuthClientTable, [{ id: createDenTypeId("orgOAuthClient"), organizationId, providerId: "slack", clientId: "organization-override", clientSecret: "override-secret", extra: null }])
  expect((await start()).searchParams.get("client_id")).toBe("synthetic-client")
  expect((await request("/v1/oauth-providers/slack/client", "POST", { clientId: "alternate" })).status).toBe(403)
  const configuration = await request("/v1/oauth-providers/slack/client")
  expect(configuration.status).toBe(200)
  expect(await configuration.text()).not.toContain("synthetic-secret")
  for (const suffix of ["client", "connect/start", "status"]) {
    expect((await request(`/v1/oauth-providers/${alternateId}/${suffix}`)).status).toBe(404)
  }
})

test("a disconnect or newer start during exchange defeats the late callback", async () => {
  const disconnected = await start()
  onTokenRequest = async () => { expect((await request("/v1/oauth-providers/slack/disconnect", "POST")).status).toBe(200) }
  expect((await callback(disconnected)).status).toBe(400)
  expect((await status()).connected).toBe(false)
  const superseded = await start()
  let newer: URL | undefined
  onTokenRequest = async () => { newer = await start() }
  expect((await callback(superseded)).status).toBe(400)
  onTokenRequest = undefined
  if (!newer) throw new Error("New pending connection missing")
  expect((await callback(newer)).status).toBe(200)
})

test.each([
  { slackEnabled: false }, { slackWorkspaceId: "TOTHER001" }, { slackOrganizationId: otherOrganizationId },
])("configuration gate changes during exchange prevent callback persistence (%#)", async (configuration) => {
  const authorize = await start()
  onTokenRequest = async () => { Object.assign(env, configuration) }
  expect((await callback(authorize)).status).toBe(400)
  Object.assign(env, { slackEnabled: true, slackWorkspaceId: "TTEST001", slackOrganizationId: organizationId })
  expect((await status()).connected).toBe(false)
})

test("a connected account cannot be reused after preview disable or workspace rotation", async () => {
  expect((await callback(await start())).status).toBe(200)
  const registry = await import("../src/capability-sources/provider-registry.js")
  const provider = registry.getNativeOAuthProvider("slack")
  if (!provider) throw new Error("Slack missing")
  const input = { provider, credentialProviderId: "slack", organizationId, orgMembershipId: memberId }
  Object.assign(env, { slackEnabled: false })
  expect(await oauth.getValidAccessToken(input)).toEqual({ error: "not_connected" })
  Object.assign(env, { slackEnabled: true, slackWorkspaceId: "TOTHER001" })
  expect(await oauth.getValidAccessToken(input)).toEqual({ error: "not_connected" })
  expect(await status()).toEqual({ connected: false, externalAccountId: null, scopes: null })
  expect(tokenRequests).toBe(1)
})

test("refresh preserves the validated member identity and updates the actual narrowed grant", async () => {
  tokenBody = {
    ok: true, team: { id: "TTEST001" }, authed_user: {
      id: "UTEST001", token_type: "user", access_token: "expiring-member-token", refresh_token: "synthetic-refresh",
      expires_in: 1, scope: "search:read.public,channels:history,search:read.private,groups:history",
    },
  }
  expect((await callback(await start())).status).toBe(200)
  // oauth.v2.access refresh_token replies use a top-level user grant, unlike
  // the nested authed_user in the initial authorization_code reply.
  // https://docs.slack.dev/authentication/using-token-rotation/#refresh
  tokenBody = {
    ok: true, id: "UTEST001", token_type: "user", access_token: "refreshed-member-token",
    refresh_token: "rotated-refresh", expires_in: 3600, scope: "search:read.public,channels:history",
  }
  const registry = await import("../src/capability-sources/provider-registry.js")
  const provider = registry.getNativeOAuthProvider("slack")
  if (!provider) throw new Error("Slack missing")
  // Public native-token driver boundary used by capability HTTP routes.
  const refreshed = await oauth.getValidAccessToken({ provider, credentialProviderId: "slack", organizationId, orgMembershipId: memberId })
  expect("accessToken" in refreshed && refreshed.accessToken).toBe("refreshed-member-token")
  expect(identityAuthorization).toBe("Bearer refreshed-member-token")
  expect(await status()).toEqual({ connected: true, externalAccountId: "slack:TTEST001:UTEST001", scopes: ["search:read.public", "channels:history"] })
})

test("a superseded non-PKCE authorization state cannot complete the newer pending connection", async () => {
  const oldAuthorize = await start()
  const currentAuthorize = await start()
  expect((await callback(oldAuthorize)).status).toBe(400)
  expect(tokenRequests).toBe(0)
  expect((await callback(currentAuthorize)).status).toBe(200)
  expect((await callback(currentAuthorize)).status).toBe(400)
  expect(tokenRequests).toBe(1)
})

test("client rotation during token exchange cannot persist a stale authorization", async () => {
  const authorize = await start()
  onTokenRequest = async () => { Object.assign(env, { slackClientSecret: "rotated-synthetic-secret" }) }
  expect((await callback(authorize)).status).toBe(400)
  expect((await status()).connected).toBe(false)
})

test("disabled preview blocks direct and desktop starts, callback, status and client config while allowing disconnect", async () => {
  const authorize = await start()
  Object.assign(env, { slackEnabled: false })
  for (const path of [
    "/v1/oauth-providers/slack/connect/start", "/v1/mcp-connections/slack/connect/start",
    "/v1/oauth-providers/slack/status", "/v1/oauth-providers/slack/client",
  ]) expect((await request(path)).status).toBe(403)
  expect((await callback(authorize)).status).toBe(403)
  expect((await request("/v1/oauth-providers/slack/client", "POST", { clientId: "alternate", clientSecret: "alternate-secret" })).status).toBe(403)
  expect(tokenRequests).toBe(0)
  expect((await request("/v1/oauth-providers/slack/disconnect", "POST")).status).toBe(200)
  Object.assign(env, { slackEnabled: true })
  expect((await status()).connected).toBe(false)
})

test("callback validates the member token with auth.test and retains only actual public grants", async () => {
  expect((await callback(await start())).status).toBe(200)
  expect(identityAuthorization).toBe("Bearer synthetic-member-token")
  expect(identityRequests).toBe(1)
  expect(await status()).toEqual({
    connected: true, externalAccountId: "slack:TTEST001:UTEST001", scopes: ["search:read.public", "channels:history"],
  })
})

test("member starts standard Slack OAuth without organization app setup, requesting only comma-delimited user scopes", async () => {
  const authorize = await start()
  expect(authorize.pathname).toBe("/oauth/v2/authorize")
  expect(authorize.searchParams.get("client_id")).toBe("synthetic-client")
  expect(authorize.searchParams.get("user_scope")).toBe("search:read.public,channels:history,search:read.private,groups:history,search:read.im,im:history,search:read.mpim,mpim:history")
  expect(authorize.searchParams.has("scope")).toBe(false)
  expect(authorize.searchParams.has("code_challenge")).toBe(false)
  expect(authorize.searchParams.has("client_secret")).toBe(false)
})
