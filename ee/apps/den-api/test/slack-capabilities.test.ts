import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { z } from "zod"
import { Hono, type MiddlewareHandler } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConnectedAccountRow, OrgOAuthClientRow } from "../src/capability-sources/oauth-credentials.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

// Synthetic storage/authentication and intercepted HTTP only. No live Slack traffic.
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test_slack"
process.env.DEN_DB_ENCRYPTION_KEY ??= "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET ??= "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const secondMemberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const now = new Date()
const allScopes = ["search:read.public", "search:read.private", "search:read.im", "search:read.mpim", "channels:history", "groups:history", "im:history", "mpim:history"]
const account: ConnectedAccountRow = {
  id: createDenTypeId("connectedAccount"), organizationId, orgMembershipId: memberId,
  providerId: "slack", externalAccountId: null, accessToken: "synthetic-member-one-token",
  refreshToken: null, tokenType: "user", scopes: [...allScopes], expiresAt: null,
  pendingCodeVerifier: null, credentialHealth: null, connectedAt: now, updatedAt: now,
}
const client: OrgOAuthClientRow = {
  id: createDenTypeId("orgOAuthClient"), organizationId, providerId: "slack",
  clientId: "synthetic-client", clientSecret: "synthetic-secret", extra: null,
  createdByOrgMembershipId: memberId, createdAt: now, updatedAt: now,
}
let app: Hono<{ Variables: OrgRouteVariables }>
let calls: Request[] = []
let replies: Response[] = []
let currentMemberId = memberId
let connected = true
let policyEnabled = true
let authenticated = true
const originalFetch = globalThis.fetch
let fixtureEnv: typeof import("../src/env.js").env
let restoreFixtureEnv = () => {}
let encodeIdentity: typeof import("../src/capability-sources/slack-policy.js").encodeSlackAccountIdentity

function json(value: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("content-type", "application/json")
  return new Response(JSON.stringify(value), { status, headers: responseHeaders })
}
function request(input: Record<string, unknown> = { query: "synthetic launch" }, headers?: HeadersInit) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) params.set(key, Array.isArray(value) ? value.join(",") : String(value))
  return app.request(`/v1/capabilities/slack/search?${params}`, { headers })
}

beforeAll(async () => {
  mock.module("../src/auth.js", () => ({ auth: { api: {} } }))
  mock.module("../src/db.js", () => ({ db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ metadata: JSON.stringify({ capabilities: { mcpConnections: policyEnabled } }) }] }) }) }),
  } }))
  const credentials = await import("../src/capability-sources/oauth-credentials.js")
  mock.module("../src/capability-sources/oauth-credentials.js", () => ({
    ...credentials,
    getOrgOAuthClient: async (org: string, provider: string) => org === organizationId && provider === "slack" ? client : null,
    getConnectedAccount: async (input: { organizationId: string; orgMembershipId: string; providerId: string }) => connected && input.organizationId === organizationId && input.providerId === "slack"
      ? { ...account, orgMembershipId: input.orgMembershipId, accessToken: input.orgMembershipId === memberId ? "synthetic-member-one-token" : "synthetic-member-two-token" }
      : null,
  }))
  mock.module("../src/orgs.js", () => ({ listTeamsForMember: async () => [] }))
  const connections = await import("../src/capability-sources/external-mcp-connections.js")
  mock.module("../src/capability-sources/external-mcp-connections.js", () => ({ ...connections, listUsableNativeProviderConnections: async () => [] }))
  const middleware = await import("../src/middleware/validation.js")
  const authenticate: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
    if (!authenticated) return next()
    c.set("organizationContext", {
      organization: { id: organizationId, name: "ENG-76 test", slug: "eng-76-test", logo: null, allowedEmailDomains: null, metadata: null, createdAt: now, updatedAt: now },
      currentMember: { id: currentMemberId, userId, role: "member", isOwner: false, createdAt: now, joinedAt: now },
      invitations: [], members: [], roles: [], teams: [],
    })
    await next()
  }
  mock.module("../src/middleware/index.js", () => ({ ...middleware, orgMemberRoute: () => authenticate }))
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const outgoing = new Request(input, init)
    calls.push(outgoing)
    const response = replies.shift()
    if (!response) throw new Error("Unexpected HTTP request in synthetic Slack test")
    return response
  }, { preconnect: originalFetch.preconnect })
  fixtureEnv = (await import("../src/env.js")).env
  const savedEnv = { slackEnabled: fixtureEnv.slackEnabled, orgMode: fixtureEnv.orgMode, slackClientId: fixtureEnv.slackClientId, slackClientSecret: fixtureEnv.slackClientSecret, slackApiBaseUrl: fixtureEnv.slackApiBaseUrl }
  restoreFixtureEnv = () => { Object.assign(fixtureEnv, savedEnv) }
  encodeIdentity = (await import("../src/capability-sources/slack-policy.js")).encodeSlackAccountIdentity
  const { registerSlackRoutes } = await import("../src/routes/org/slack.js")
  app = new Hono<{ Variables: OrgRouteVariables }>()
  registerSlackRoutes(app)
})

beforeEach(() => {
  calls = []
  replies = []
  connected = true
  policyEnabled = true
  authenticated = true
  currentMemberId = memberId
  account.scopes = [...allScopes]
  account.externalAccountId = encodeIdentity({ workspaceId: "TSYNTHETIC", userId: "U001" })
  fixtureEnv.slackEnabled = true
  fixtureEnv.orgMode = "multi_org"
  fixtureEnv.slackClientId = "synthetic-client"
  fixtureEnv.slackClientSecret = "synthetic-secret"
  fixtureEnv.slackApiBaseUrl = "https://slack.com/api"
})

afterAll(() => {
  restoreFixtureEnv()
  globalThis.fetch = originalFetch
  mock.restore()
})

function thread(params = "channelId=C001&ts=1000.000001") {
  return app.request(`/v1/capabilities/slack/threads?${params}`)
}

test("reads one thread page with source permalinks, preserves its cursor, and labels it an excerpt", async () => {
  replies.push(
    json({ ok: true, messages: [{ type: "message", ts: "1000.000001", thread_ts: "1000.000001", user: "U001", text: "Synthetic parent", reply_count: 3 }, { type: "message", ts: "1000.000002", thread_ts: "1000.000001", user: "U002", text: "Synthetic reply" }], has_more: true, response_metadata: { next_cursor: "thread-page-two" } }),
    json({ ok: true, permalink: "https://synthetic.slack.com/archives/C001/p1000000001" }),
    json({ ok: true, permalink: "https://synthetic.slack.com/archives/C001/p1000000002?thread_ts=1000.000001&cid=C001" }),
  )
  const response = await thread("channelId=C001&ts=1000.000001&limit=2")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, context: "thread_excerpt", partial: true, truncated: false, nextCursor: "thread-page-two", hasMore: true, messages: [{ text: "Synthetic parent", threadTs: "1000.000001" }, { text: "Synthetic reply", permalink: "https://synthetic.slack.com/archives/C001/p1000000002?thread_ts=1000.000001&cid=C001" }] })
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/conversations.replies", "/api/chat.getPermalink", "/api/chat.getPermalink"])
  expect(calls[0]?.url).toBe("https://slack.com/api/conversations.replies?channel=C001&ts=1000.000001&limit=2")
  expect(calls[1]?.url).toBe("https://slack.com/api/chat.getPermalink?channel=C001&message_ts=1000.000001")
})

test("member-private lookups use each member's own account and forbid caching", async () => {
  replies.push(json({ ok: true, results: { messages: [{ channel_id: "GPRIVATE", message_ts: "1000.000001", content: "Synthetic private member-one discussion", permalink: "https://synthetic.slack.com/archives/GPRIVATE/p1000000001" }] } }))
  const first = await request()
  expect(first.status).toBe(200)
  expect(await first.text()).toContain("Synthetic private member-one discussion")
  currentMemberId = secondMemberId
  replies.push(json({ ok: false, error: "channel_not_found" }))
  const second = await thread("channelId=GPRIVATE&ts=1000.000001")
  expect(second.status).toBe(404)
  expect(calls.map((call) => call.headers.get("authorization"))).toEqual(["Bearer synthetic-member-one-token", "Bearer synthetic-member-two-token"])
  expect(first.headers.get("cache-control")).toBe("no-store")
  expect(second.headers.get("cache-control")).toBe("no-store")
  expect(await second.text()).not.toContain("Synthetic private member-one discussion")
})

test("public schemas expose only GET search and thread reads, including query and result bounds", async () => {
  const { generateSpecs } = await import("hono-openapi")
  const spec = await generateSpecs(app)
  const search = spec.paths?.["/v1/capabilities/slack/search"]
  expect(search?.post).toBeUndefined()
  expect(search?.get?.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "query", in: "query", required: true }),
    expect.objectContaining({ name: "conversationTypes", in: "query", schema: expect.objectContaining({ type: "string" }) }),
    expect.objectContaining({ name: "limit", in: "query", schema: expect.objectContaining({ type: "integer", maximum: 20, minimum: 1, default: 10 }) }),
  ]))
  expect(spec.paths?.["/v1/capabilities/slack/threads"]?.get).toBeDefined()
  expect((await app.request("/v1/capabilities/slack/search", { method: "POST" })).status).toBe(404)
  expect(calls).toHaveLength(0)
})

test("missing authenticated member context fails closed before Slack HTTP", async () => {
  authenticated = false
  expect((await request()).status).toBe(401)
  expect((await thread()).status).toBe(401)
  expect(calls).toHaveLength(0)
})

test("public-only partial consent searches only public conversations and lists omitted categories", async () => {
  account.scopes = ["search:read.public", "channels:history"]
  replies.push(json({ ok: true, results: { messages: [] } }))
  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ searchedConversationTypes: ["public_channel"], omittedConversationTypes: ["private_channel", "im", "mpim"], partial: true, hasMore: false })
  expect(await calls[0]?.json()).toMatchObject({ channel_types: ["public_channel"], content_types: ["messages"] })
})

for (const category of ["private_channel", "im", "mpim"]) {
  test(`explicit unauthorized ${category} search is a permission error, not no results`, async () => {
    account.scopes = ["search:read.public", "channels:history"]
    const response = await request({ query: "synthetic", conversationTypes: [category] })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "missing_permission" })
    expect(calls).toHaveLength(0)
  })
}

test("unknown grants fail closed for search and thread reads", async () => {
  account.scopes = null
  expect((await request()).status).toBe(409)
  expect((await thread()).status).toBe(409)
  expect(calls).toHaveLength(0)
})

for (const code of ["token_revoked", "token_expired", "invalid_auth", "account_inactive"]) {
  test(`HTTP 200 ${code} asks to reconnect without leaking the upstream body`, async () => {
    replies.push(json({ ok: false, error: code, message: "private-provider-text", access_token: "must-not-escape" }))
    const response = await request()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "needs_connection", message: "Connect or reconnect your Slack account in Your Connections, then retry." })
    expect(calls).toHaveLength(1)
  })
}

test("HTTP 429 returns bounded Retry-After without retries or provider text", async () => {
  replies.push(new Response("private-provider-text", { status: 429, headers: { "retry-after": "999999999" } }))
  const response = await request()
  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("3600")
  expect(await response.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 3600 })
  expect(calls).toHaveLength(1)
})

test("RTS eligibility rejection never falls back to legacy search", async () => {
  replies.push(json({ ok: false, error: "feature_not_enabled", message: "private-provider-text" }))
  const response = await request()
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("private-provider-text")
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/assistant.search.context"])
})

for (const state of ["disabled", "single_org", "unverified_identity", "connect_disabled", "disconnected"]) {
  test(`retained search and thread routes reject ${state} before downstream HTTP`, async () => {
    if (state === "disabled") fixtureEnv.slackEnabled = false
    if (state === "single_org") fixtureEnv.orgMode = "single_org"
    if (state === "unverified_identity") account.externalAccountId = "U001"
    if (state === "connect_disabled") policyEnabled = false
    if (state === "disconnected") connected = false
    const expected = state === "disconnected" || state === "unverified_identity" ? 409 : 403
    expect((await request()).status).toBe(expected)
    expect((await thread()).status).toBe(expected)
    expect(calls).toHaveLength(0)
  })
}

test("signed unavailable connector selection never falls back to the Slack account", async () => {
  const session = await import("../src/session.js")
  const response = await request(undefined, {
    "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId }),
    "x-den-internal-capability-connector": session.createInternalCapabilityConnectorHeader({ userId, organizationId, connectorId: "not-the-native-slack-account" }),
  })
  expect(response.status).toBe(409)
  expect(calls).toHaveLength(0)
})

test("arbitrary client selection headers cannot select another member's token", async () => {
  replies.push(json({ ok: true, results: { messages: [] } }))
  const response = await request(undefined, { "x-den-internal-capability-connector": "another-member-account", "x-connector-id": "another-member-account" })
  expect(response.status).toBe(200)
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer synthetic-member-one-token")
})

test("a signed native alias selects only the calling member's Slack account", async () => {
  const session = await import("../src/session.js")
  replies.push(json({ ok: true, results: { messages: [] } }))
  const response = await request(undefined, {
    "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId }),
    "x-den-internal-capability-connector": session.createInternalCapabilityConnectorHeader({ userId, organizationId, connectorId: "slack" }),
  })
  expect(response.status).toBe(200)
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer synthetic-member-one-token")
})

test("message count and per-message/total text are bounded and visibly truncated", async () => {
  replies.push(json({ ok: true, results: { messages: Array.from({ length: 25 }, (_, i) => ({ channel_id: "C001", message_ts: `1000.${i + 1}`, content: "x".repeat(5_000), permalink: "https://synthetic.slack.com/archives/C001/p1000000001" })) } }))
  const response = await request({ query: "synthetic", limit: 20 })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ truncated: true, partial: true })
  const parsed = z.object({ messages: z.array(z.object({ text: z.string(), truncated: z.boolean() })) }).parse(body)
  expect(parsed.messages).toHaveLength(20)
  expect(parsed.messages.every((message) => message.text.length <= 4_000 && message.truncated)).toBe(true)
  expect(parsed.messages.reduce((total, message) => total + message.text.length, 0)).toBe(40_000)
  expect(calls).toHaveLength(1)
})

test("oversized chunked Slack bodies are stopped without returning provider content", async () => {
  let produced = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { produced += 1; controller.enqueue(new TextEncoder().encode("private-provider-text".repeat(4_096))) },
    cancel() { cancelled = true },
  })
  replies.push(new Response(stream))
  const response = await request()
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("private-provider-text")
  expect(cancelled).toBe(true)
  expect(produced).toBeLessThan(10)
  expect(calls).toHaveLength(1)
})

test("malformed Slack success payloads are not misreported as an empty search", async () => {
  replies.push(json({ ok: true, unexpected: "private-provider-text" }))
  const response = await request()
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("private-provider-text")
})

test("search and thread cursors go to exactly one provider page", async () => {
  replies.push(json({ ok: true, results: { messages: [] }, response_metadata: { next_cursor: "search-more" } }))
  const search = await request({ query: "synthetic", conversationTypes: "public_channel,im", cursor: "search-start", limit: 2 })
  expect(search.status).toBe(200)
  expect(await search.json()).toMatchObject({ nextCursor: "search-more", hasMore: true })
  expect(await calls[0]?.json()).toMatchObject({ cursor: "search-start", limit: 2, channel_types: ["public_channel", "im"] })
  replies.push(json({ ok: true, messages: [], has_more: true, is_limited: true, response_metadata: { next_cursor: "thread-more" } }))
  const read = await thread("channelId=C001&ts=1000.000001&cursor=thread-start&limit=2")
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ nextCursor: "thread-more", hasMore: true, historyLimited: true, partial: true })
  expect(new URL(calls[1]?.url ?? "https://invalid.test").searchParams.get("cursor")).toBe("thread-start")
  expect(calls).toHaveLength(2)
})

test("search missing a trustworthy source link resolves it through chat.getPermalink", async () => {
  replies.push(
    json({ ok: true, results: { messages: [{ channel_id: "C001", message_ts: "1000.000001", content: "Synthetic text", permalink: "https://attacker.invalid/token-collector" }] } }),
    json({ ok: true, permalink: "https://synthetic.slack.com/archives/C001/p1000000001" }),
  )
  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ messages: [{ permalink: "https://synthetic.slack.com/archives/C001/p1000000001" }] })
  expect(calls.map((call) => call.url)).toEqual(["https://slack.com/api/assistant.search.context", "https://slack.com/api/chat.getPermalink?channel=C001&message_ts=1000.000001"])
  expect(calls.every((call) => call.redirect === "error")).toBe(true)
})

test("rate limiting during source resolution stops immediately without unlinked private excerpts", async () => {
  replies.push(
    json({ ok: true, messages: [{ ts: "1000.000001", text: "private synthetic message" }, { ts: "1000.000002", text: "another synthetic message" }] }),
    json({ ok: false, error: "ratelimited" }),
  )
  const response = await thread()
  expect(response.status).toBe(429)
  expect(await response.text()).not.toContain("private synthetic message")
  expect(calls).toHaveLength(2)
})

test("a single twelve-second deadline covers the entire lookup, with no retry", async () => {
  const deadline = spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("Synthetic deadline", "TimeoutError")))
  try {
    const response = await request()
    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({ error: "slack_api_error" })
    expect(deadline).toHaveBeenCalledTimes(1)
    expect(deadline).toHaveBeenCalledWith(12_000)
    expect(calls).toHaveLength(0)
  } finally { deadline.mockRestore() }
})

for (const input of [{ query: "" }, { query: "x".repeat(1_001) }, { query: "synthetic", limit: 21 }, { query: "synthetic", conversationTypes: "files" }, { query: "synthetic", cursor: "x".repeat(2_049) }, { query: "synthetic", method: "chat.postMessage" }, { query: "synthetic", token: "arbitrary-token" }, { query: "synthetic", origin: "https://attacker.invalid" }]) {
  test(`invalid search query keys or bounds are rejected: ${Object.keys(input).join(",")}`, async () => {
    expect((await request(input)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
}

test("thread input and unknown write routes cannot become an arbitrary method proxy", async () => {
  expect((await thread("channelId=https://attacker.invalid&ts=1000.000001")).status).toBe(400)
  expect((await thread("channelId=C001&ts=not-a-timestamp")).status).toBe(400)
  expect((await thread("channelId=C001&ts=1000.000001&limit=1000")).status).toBe(400)
  expect((await thread("channelId=C001&ts=1000.000001&method=chat.postMessage")).status).toBe(400)
  expect((await app.request("/v1/capabilities/slack/post", { method: "POST" })).status).toBe(404)
  expect(calls).toHaveLength(0)
})

test("HTTP 200 missing_scope is a recoverable permission state with safe scope detail", async () => {
  replies.push(json({ ok: false, error: "missing_scope", needed: "search:read.private,private-provider-text", provided: "search:read.public", message: "secret provider detail" }))
  const response = await request({ query: "synthetic", conversationTypes: ["private_channel"] })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: "missing_permission", missingScopes: ["search:read.private"] })
  expect(calls).toHaveLength(1)
})

test("search returns source-linked message excerpts through RTS, never legacy search or file results", async () => {
  replies.push(json({ ok: true, results: { messages: [{ channel_id: "C001", message_ts: "1000.000001", content: "Synthetic launch is ready", author_user_id: "U001", permalink: "https://synthetic.slack.com/archives/C001/p1000000001" }], files: [{ content: "must not escape" }] }, response_metadata: { next_cursor: "next-synthetic-page" } }))
  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    ok: true, partial: true, context: "search_results", hasMore: true, nextCursor: "next-synthetic-page",
    messages: [{ channelId: "C001", ts: "1000.000001", text: "Synthetic launch is ready", userId: "U001", permalink: "https://synthetic.slack.com/archives/C001/p1000000001", truncated: false }],
    searchedConversationTypes: ["public_channel", "private_channel", "im", "mpim"], omittedConversationTypes: [],
  })
  expect(calls).toHaveLength(1)
  const outgoing = calls[0]
  expect(outgoing?.url).toBe("https://slack.com/api/assistant.search.context")
  expect(outgoing?.method).toBe("POST")
  expect(outgoing?.headers.get("authorization")).toBe("Bearer synthetic-member-one-token")
  expect(await outgoing?.json()).toEqual({ query: "synthetic launch", channel_types: ["public_channel", "private_channel", "im", "mpim"], content_types: ["messages"], include_context_messages: false, include_message_blocks: false, limit: 10 })
})
