import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import type { NativeOAuthProviderConfig } from "../src/capability-sources/provider-registry.js"

// Synthetic provider HTTP boundary only. Never contacts Slack or reads live credentials.
let tokenBody: unknown
let tokenStatus = 200
let receivedParams = new URLSearchParams()
let receivedAuthorization: string | null = null
let redirectTokenRequest = false
let redirectedRequests = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (redirectTokenRequest && path === "/api/oauth.v2.access") {
      return new Response(null, { status: 307, headers: { location: `${server.url.origin}/redirected-token` } })
    }
    if (path === "/redirected-token") redirectedRequests++
    receivedParams = new URLSearchParams(await request.text())
    receivedAuthorization = request.headers.get("authorization")
    return Response.json(tokenBody, { status: tokenStatus })
  },
})
const provider: NativeOAuthProviderConfig = {
  providerId: "slack",
  displayName: "Slack",
  authorizeUrl: `${server.url.origin}/oauth/v2/authorize`,
  tokenUrl: `${server.url.origin}/api/oauth.v2.access`,
  websiteUrl: "https://slack.com",
  defaultScopes: ["search:read.public", "channels:history"],
  usesPkce: false,
}
const client = { clientId: "synthetic-client", clientSecret: "synthetic-secret", extra: null }
let oauth: typeof import("../src/capability-sources/generic-oauth.js")

beforeAll(async () => {
  process.env.DATABASE_URL = "mysql://unused:unused@127.0.0.1:1/slack_oauth_test"
  process.env.DEN_DB_ENCRYPTION_KEY = "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = "y".repeat(32)
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
  oauth = await import("../src/capability-sources/generic-oauth.js")
})
beforeEach(() => {
  redirectTokenRequest = false
  redirectedRequests = 0
  tokenStatus = 200
  tokenBody = {
    ok: true,
    access_token: "synthetic-bot-token",
    token_type: "bot",
    scope: "chat:write",
    team: { id: "TTEST001" },
    is_enterprise_install: false,
    authed_user: {
      id: "UTEST001",
      access_token: "synthetic-member-token",
      token_type: "user",
      scope: "search:read.public,channels:history",
    },
  }
})
afterAll(() => { server.stop(true) })

function exchange() {
  return oauth.exchangeCodeForTokens({
    provider, client, code: "synthetic-code", redirectUri: "https://den.example.test/callback",
  })
}

test.each([
  { ok: false, error: "invalid_auth", authed_user: { access_token: "must-not-use", token_type: "user" } },
  { ok: true, access_token: "bot-only", token_type: "bot" },
  { ok: true, access_token: "top-level-user", token_type: "user", refresh_token: "refresh-only-grant", expires_in: 43200 },
  { ok: true, access_token: "top-level-user", token_type: "user", authed_user: { access_token: "nested-bot", token_type: "bot" } },
  { ok: true, authed_user: { access_token: "nested-bot", token_type: "bot" } },
  { ok: true, authed_user: { access_token: "", token_type: "user" } },
  { ok: true, is_enterprise_install: true, authed_user: { access_token: "org-wide", token_type: "user" } },
])("rejects unsuccessful, non-member, and enterprise-wide HTTP-200 Slack grants (%#)", async (body) => {
  tokenBody = body
  await expect(exchange()).rejects.toBeInstanceOf(oauth.OAuthTokenExchangeError)
})

test("Slack token errors never expose untrusted provider content in diagnostics", async () => {
  tokenStatus = 400
  tokenBody = { error: "raw-sensitive-provider-content", error_description: "synthetic-secret" }
  try {
    await exchange()
    throw new Error("Expected the token exchange to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(oauth.OAuthTokenExchangeError)
    if (!(error instanceof oauth.OAuthTokenExchangeError)) throw error
    expect(JSON.stringify(error.details)).not.toContain("raw-sensitive-provider-content")
    expect(error.message).not.toContain("synthetic-secret")
  }
})

test("Slack authorization codes and client credentials never follow a token endpoint redirect", async () => {
  redirectTokenRequest = true
  await expect(exchange()).rejects.toBeInstanceOf(oauth.OAuthTokenExchangeError)
  expect(redirectedRequests).toBe(0)
})

test("standard Slack exchange uses only the nested member token and its actual grants", async () => {
  const tokens = await exchange()
  expect(tokens.access_token).toBe("synthetic-member-token")
  expect(tokens.token_type).toBe("user")
  expect(tokens.scope).toBe("search:read.public,channels:history")
  expect(receivedParams.get("grant_type")).toBe("authorization_code")
  expect(receivedParams.get("code")).toBe("synthetic-code")
  expect(receivedParams.get("redirect_uri")).toBe("https://den.example.test/callback")
  expect(receivedParams.has("code_verifier")).toBe(false)
  expect(receivedAuthorization).toBe(`Basic ${Buffer.from("synthetic-client:synthetic-secret").toString("base64")}`)
  expect(receivedParams.has("client_secret")).toBe(false)
})
