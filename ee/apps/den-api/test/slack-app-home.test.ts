import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { after, before, beforeEach, test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { Hono } from "hono"

// Approved seam: signed public Slack Events HTTP -> synthetic Slack Web API HTTP.
// No live credentials, Slack requests, database, app configuration, or activation.
process.env.DATABASE_URL = "mysql://unused:unused@127.0.0.1:1/slack_home_test"
process.env.DEN_DB_ENCRYPTION_KEY = "x".repeat(32)
process.env.BETTER_AUTH_SECRET = "y".repeat(32)
process.env.BETTER_AUTH_URL = "https://den.example.test"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_SLACK_ENABLED = "false"
process.env.DEN_SLACK_SIGNING_SECRET = "synthetic-signing-secret"
process.env.DEN_SLACK_API_BASE_URL = "http://127.0.0.1:1/api"

const signingSecret = "synthetic-signing-secret"
const calls: { path: string; authorization: string | undefined; body: unknown }[] = []
let authResult: unknown = { ok: true, team_id: "TTEST001", bot_id: "BTEST001" }
let publishResult: unknown = { ok: true }
let onAuthRequest: () => void = () => {}
let authDelayMs = 0
let publishDelayMs = 0
let tokens = new Map<string, string>()
let tokenLookup: (workspaceId: string, signal: AbortSignal) => Promise<string | null>
const downstream = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  calls.push({ path: req.url ?? "", authorization: req.headers.authorization, body: JSON.parse(body) })
  if (req.url === "/api/auth.test") onAuthRequest()
  const result = req.url === "/api/auth.test" ? authResult : publishResult
  const delay = req.url === "/api/auth.test" ? authDelayMs : publishDelayMs
  if (delay) await setTimeout(delay)
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(result))
})
let app: Hono
let env: typeof import("../src/env.js").env
let register: typeof import("../src/routes/slack-app-home.js").registerSlackAppHomeRoutes

before(async () => {
  downstream.listen(0, "127.0.0.1")
  await once(downstream, "listening")
  const address = downstream.address()
  assert.ok(address && typeof address !== "string")
  process.env.DEN_SLACK_API_BASE_URL = `http://127.0.0.1:${address.port}/api`
  env = (await import("../src/env.js")).env
  register = (await import("../src/routes/slack-app-home.js")).registerSlackAppHomeRoutes
})
beforeEach(() => {
  calls.length = 0
  env.slackEnabled = true
  env.orgMode = "multi_org"
  env.slackClientId = "synthetic-client"
  env.slackClientSecret = "synthetic-secret"
  env.slackSigningSecret = signingSecret
  tokens = new Map([["TTEST001", "synthetic-home-token"], ["TOTHER001", "synthetic-other-home-token"]])
  tokenLookup = async workspaceId => tokens.get(workspaceId) ?? null
  authResult = { ok: true, team_id: "TTEST001", bot_id: "BTEST001" }
  publishResult = { ok: true }
  onAuthRequest = () => {}
  authDelayMs = 0
  publishDelayMs = 0
  app = new Hono()
  // The production signedWebhookRoute policy marker is also pass-through;
  // signature verification is exercised in full by the registered endpoint.
  register(app, async (_c, next) => { await next() }, (workspaceId, signal) => tokenLookup(workspaceId, signal))
})
after(async () => {
  downstream.closeAllConnections()
  await new Promise<void>((resolve, reject) => downstream.close(error => error ? reject(error) : resolve()))
})

function signed(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex")}`,
  }
}
function event(teamId = "TTEST001", eventId = "EvTEST001") {
  return { type: "event_callback", team_id: teamId, event_id: eventId, event: { type: "app_home_opened", user: "UTEST001", tab: "home" } }
}
function send(value: unknown, headers?: HeadersInit) {
  const body = JSON.stringify(value)
  return app.request("/v1/slack/events", { method: "POST", body, headers: headers ?? signed(body) })
}

test("unsigned, stale, future, and body-tampered requests are rejected before verification", async () => {
  const value = { type: "url_verification", challenge: "synthetic-challenge" }
  const body = JSON.stringify(value)
  const now = Math.floor(Date.now() / 1000)
  for (const headers of [
    { "content-type": "application/json" },
    signed(body, String(now - 301)),
    signed(body, String(now + 301)),
    signed(JSON.stringify({ ...value, challenge: "tampered" })),
    { ...signed(body), "x-slack-signature": "v0=bad" },
  ]) {
    const response = await send(value, headers)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "invalid_signature" })
  }
  assert.equal(calls.length, 0)
})

test("verification stays unavailable while disabled or on a single-org deployment", async () => {
  const value = { type: "url_verification", challenge: "synthetic-challenge" }
  env.slackEnabled = false
  assert.equal((await send(value)).status, 403)
  env.slackEnabled = true
  env.orgMode = "single_org"
  assert.equal((await send(value)).status, 403)
  assert.equal(calls.length, 0)
})

test("an approved Home visit publishes only compact read-only connection help", async () => {
  const response = await send(event())
  assert.equal(response.status, 200)
  assert.deepEqual(calls.map(call => call.path), ["/api/auth.test", "/api/views.publish"])
  assert.ok(calls.every(call => call.authorization === "Bearer synthetic-home-token"))
  assert.deepEqual(calls[0]?.body, {})
  assert.deepEqual(calls[1]?.body, {
    user_id: "UTEST001",
    view: {
      type: "home",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "OpenWork Connect" } },
        { type: "section", fields: [
          { type: "mrkdwn", text: "*Read access*\nOnly conversations you authorize" },
          { type: "mrkdwn", text: "*Posting and replies*\nNot supported" },
        ] },
        { type: "context", elements: [{ type: "plain_text", text: "Account connection not verified here." }] },
        { type: "section", text: { type: "mrkdwn", text: "<https://den.example.test/dashboard/your-connections|Manage connections>" } },
      ],
    },
  })
})

test("a workspace without an installation cannot borrow a different workspace's bot token", async () => {
  assert.equal((await send(event("TUNKNOWN"))).status, 503)
  assert.equal(calls.length, 0)
})

test("a second workspace gets its own installed token without environment configuration", async () => {
  authResult = { ok: true, team_id: "TOTHER001", bot_id: "BOTHER001" }
  assert.equal((await send(event("TOTHER001"))).status, 200)
  assert.ok(calls.every(call => call.authorization === "Bearer synthetic-other-home-token"))
})

test("an unavailable installation store cannot exceed the response deadline", async () => {
  tokenLookup = () => new Promise(() => {})
  const start = performance.now()
  assert.equal((await send(event())).status, 504)
  assert.ok(performance.now() - start < 2800)
  assert.equal(calls.length, 0)
})

test("a wrong-workspace bot token cannot publish even for an approved event", async () => {
  authResult = { ok: true, team_id: "TOTHER001", bot_id: "BTEST001" }
  assert.equal((await send(event())).status, 403)
  assert.deepEqual(calls.map(call => call.path), ["/api/auth.test"])
})

test("rotating the platform app during auth.test blocks publication", async () => {
  onAuthRequest = () => { env.slackClientId = "rotated-client" }
  assert.equal((await send(event())).status, 403)
  assert.deepEqual(calls.map(call => call.path), ["/api/auth.test"])
})

test("oversized signed event bodies are rejected without downstream calls", async () => {
  const response = await send({ ...event(), padding: "x".repeat(32 * 1024) })
  assert.equal(response.status, 413)
  assert.equal(calls.length, 0)
})

test("malformed signed JSON fails safely without publishing or reflecting request content", async () => {
  const body = '{"synthetic-invalid"'
  const response = await app.request("/v1/slack/events", { method: "POST", headers: signed(body), body })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: "invalid_body" })
  assert.equal(calls.length, 0)
})

test("message events and non-Home visits are rejected without delivery retries", async () => {
  for (const eventPayload of [
    { type: "message", user: "UTEST001", text: "synthetic content" },
    { type: "app_home_opened", user: "UTEST001", tab: "messages" },
  ]) {
    const response = await send({ ...event(), event: eventPayload })
    assert.equal(response.status, 400)
    assert.equal(response.headers.get("x-slack-no-retry"), "1")
  }
  assert.equal(calls.length, 0)
})

test("replayed Home delivery is acknowledged once without republishing", async () => {
  assert.equal((await send(event())).status, 200)
  assert.equal((await send(event())).status, 200)
  assert.deepEqual(calls.map(call => call.path), ["/api/auth.test", "/api/views.publish"])
  env.slackEnabled = false
  assert.equal((await send(event())).status, 403)
})

test("the per-process delivery window is bounded even when Slack rejects tokens", async () => {
  authResult = { ok: false, error: "synthetic-provider-error" }
  for (let index = 0; index < 256; index++) {
    assert.equal((await send(event("TTEST001", `EvTEST${index}`))).status, 502)
  }
  const response = await send(event("TTEST001", "EvOVERBUDGET"))
  assert.equal(response.status, 429)
  assert.equal(calls.length, 256)
})

test("auth and publication share one deadline shorter than Slack's acknowledgement window", async () => {
  authDelayMs = 1500
  publishDelayMs = 1500
  const start = performance.now()
  const response = await send(event())
  assert.equal(response.status, 504)
  assert.ok(performance.now() - start < 2800)
  assert.deepEqual(await response.json(), { error: "home_unavailable" })
  assert.equal(response.headers.get("x-slack-no-retry"), "1")
  assert.deepEqual(calls.map(call => call.path), ["/api/auth.test", "/api/views.publish"])
})

test("an unfinished signed request body is cancelled within the acknowledgement deadline", async () => {
  const body = JSON.stringify(event())
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await setTimeout(3000)
      if (cancelled) return
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const init = { method: "POST", body: stream, headers: signed(body), duplex: "half" }
  const start = performance.now()
  const response = await app.request("/v1/slack/events", init)
  assert.equal(response.status, 408)
  assert.ok(performance.now() - start < 2800)
  assert.equal(cancelled, true)
  assert.equal(calls.length, 0)
})

test("oversized provider responses fail safely without publication", async () => {
  authResult = { ok: true, team_id: "TTEST001", bot_id: "BTEST001", padding: "x".repeat(64 * 1024) }
  const response = await send(event())
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: "home_unavailable" })
  assert.deepEqual(calls.map(call => call.path), ["/api/auth.test"])
})

test("the Cloud rollout is rechecked after receiving the signed body", async () => {
  const body = JSON.stringify(event())
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      env.slackEnabled = false
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }, { highWaterMark: 0 })
  const init = { method: "POST", body: stream, headers: signed(body), duplex: "half" }
  const response = await app.request("/v1/slack/events", init)
  assert.equal(response.status, 403)
  assert.equal(calls.length, 0)
})

test("excess concurrent Home deliveries are refused rather than queued", async () => {
  authDelayMs = 100
  const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => send(event("TTEST001", `EvCONCURRENT${index}`))))
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 200, 200, 429])
  assert.equal(calls.filter(call => call.path === "/api/auth.test").length, 4)
  assert.equal(calls.filter(call => call.path === "/api/views.publish").length, 4)
})

test("timed-out storage waits retain their admission slots until they settle", async () => {
  const releases: (() => void)[] = []
  tokenLookup = () => new Promise(resolve => { releases.push(() => resolve("synthetic-home-token")) })
  const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => send(event("TTEST001", `EvWAIT${index}`))))
  assert.ok(responses.every(response => response.status === 504))
  assert.equal((await send(event("TTEST001", "EvWAITOVERFLOW"))).status, 429)
  assert.equal(releases.length, 4)
  for (const release of releases) release()
  await setTimeout(0)
  assert.equal(calls.length, 0)
  tokenLookup = async () => "synthetic-home-token"
  assert.equal((await send(event("TTEST001", "EvRECOVERED"))).status, 200)
})

test("a signed URL verification returns the challenge without calling Slack", async () => {
  // Whitespace is signed too: reparsing/reserializing before HMAC must not work.
  const body = JSON.stringify({ type: "url_verification", challenge: "synthetic-challenge" }, null, 2)
  const response = await app.request("/v1/slack/events", { method: "POST", body, headers: signed(body) })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { challenge: "synthetic-challenge" })
  assert.equal(calls.length, 0)
})
