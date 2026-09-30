import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { after, before, beforeEach, test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { sql } from "@openwork-ee/den-db/drizzle"

const databaseUrl = process.env.DEN_SLACK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error("Set DEN_SLACK_TEST_DATABASE_URL to a disposable loopback *_slack_installations_test database")
const database = new URL(databaseUrl)
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !/^\/[a-z0-9_]+_slack_installations_test$/.test(database.pathname)) {
  throw new Error("Slack installation tests require an isolated loopback *_slack_installations_test database")
}
process.env.DATABASE_URL = databaseUrl
process.env.DATABASE_REDIS_URL = ""
process.env.DEN_DB_ENCRYPTION_KEY = "synthetic-slack-installations-key-1234567890"
process.env.BETTER_AUTH_SECRET = "synthetic-slack-installations-auth-1234567890"
process.env.BETTER_AUTH_URL = "https://den.example.test"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_ORG_MODE = "multi_org"
process.env.DEN_SLACK_ENABLED = "true"
process.env.DEN_SLACK_CLIENT_ID = "synthetic-client"
process.env.DEN_SLACK_CLIENT_SECRET = "synthetic-secret"

let refreshes = 0
let result: unknown
let onRefresh = () => {}
const provider = createServer(async (request, response) => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  assert.equal(request.url, "/oauth.v2.access")
  assert.equal(request.headers.authorization, `Basic ${Buffer.from("synthetic-client:synthetic-secret").toString("base64")}`)
  assert.equal(new URLSearchParams(raw).get("grant_type"), "refresh_token")
  refreshes++
  onRefresh()
  await setTimeout(30)
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(result))
})
let db: typeof import("../src/db.js").db
let storage: typeof import("../src/capability-sources/slack-installations.js")
let env: typeof import("../src/env.js").env
let client: typeof import("../src/db.js").client
before(async () => {
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  const address = provider.address()
  assert.ok(address && typeof address !== "string")
  process.env.DEN_SLACK_OAUTH_TOKEN_URL = `http://127.0.0.1:${address.port}/oauth.v2.access`
  storage = await import("../src/capability-sources/slack-installations.js")
  env = (await import("../src/env.js")).env
  client = (await import("../src/db.js")).client
  db = (await import("../src/db.js")).db
})
beforeEach(async () => {
  await db.execute(sql`DELETE FROM slack_installation`)
  env.slackEnabled = true
  env.orgMode = "multi_org"
  env.slackClientId = "synthetic-client"
  env.slackClientSecret = "synthetic-secret"
  refreshes = 0
  onRefresh = () => {}
  result = { ok: true, token_type: "bot", team: { id: "TFIRST" }, access_token: "rotated-bot", refresh_token: "rotated-refresh", expires_in: 3600 }
})
after(async () => {
  await db.execute(sql`DELETE FROM slack_installation`)
  if ("end" in client) await client.end()
  provider.closeAllConnections()
  await new Promise<void>(resolve => provider.close(() => resolve()))
})
const signal = () => AbortSignal.timeout(2000)
const expiring = () => storage.saveSlackInstallation("synthetic-client", "TFIRST", {
  accessToken: "expired-bot", refreshToken: "synthetic-refresh", expiresAt: new Date(Date.now() - 60_000),
})

test("installation tokens are encrypted at rest and selected by both app and workspace", async () => {
  await storage.saveSlackInstallation("synthetic-client", "TFIRST", { accessToken: "first-bot", refreshToken: "first-refresh", expiresAt: null })
  await storage.saveSlackInstallation("synthetic-client", "TSECOND", { accessToken: "second-bot", refreshToken: null, expiresAt: null })
  await storage.saveSlackInstallation("another-client", "TFIRST", { accessToken: "another-app-bot", refreshToken: null, expiresAt: null })
  assert.equal(await storage.getSlackHomeToken("TFIRST", signal()), "first-bot")
  assert.equal(await storage.getSlackHomeToken("TSECOND", signal()), "second-bot")
  assert.equal(await storage.getSlackHomeToken("TUNKNOWN", signal()), null)
  const rows = await db.execute(sql`SELECT access_token, refresh_token FROM slack_installation`)
  const serialized = JSON.stringify(rows)
  for (const secret of ["first-bot", "first-refresh", "second-bot", "another-app-bot"]) assert.equal(serialized.includes(secret), false)
  assert.equal(refreshes, 0)
})

test("concurrent bot refreshes serialize and persist one rotated grant", async () => {
  await expiring()
  assert.deepEqual(await Promise.all([storage.getSlackHomeToken("TFIRST", signal()), storage.getSlackHomeToken("TFIRST", signal())]), ["rotated-bot", "rotated-bot"])
  assert.equal(await storage.getSlackHomeToken("TFIRST", signal()), "rotated-bot")
  assert.equal(refreshes, 1)
})

test("wrong-workspace and user-token refreshes cannot replace a bot installation", async () => {
  await expiring()
  for (const invalid of [
    { ok: true, token_type: "bot", team: { id: "TSECOND" }, access_token: "foreign", refresh_token: "foreign-refresh", expires_in: 3600 },
    { ok: true, token_type: "user", team: { id: "TFIRST" }, access_token: "user", refresh_token: "user-refresh", expires_in: 3600 },
  ]) {
    result = invalid
    assert.equal(await storage.getSlackHomeToken("TFIRST", signal()), null)
  }
  result = { ok: true, token_type: "bot", team: { id: "TFIRST" }, access_token: "valid", refresh_token: "valid-refresh", expires_in: 3600 }
  assert.equal(await storage.getSlackHomeToken("TFIRST", signal()), "valid")
  assert.equal(refreshes, 3)
})

test("disabled and single-org deployments cannot use stored bot tokens", async () => {
  await expiring()
  env.slackEnabled = false
  assert.equal(await storage.getSlackHomeToken("TFIRST", signal()), null)
  env.slackEnabled = true
  env.orgMode = "single_org"
  assert.equal(await storage.getSlackHomeToken("TFIRST", signal()), null)
  assert.equal(refreshes, 0)
})

test("platform credential changes during refresh prevent persistence", async () => {
  await expiring()
  onRefresh = () => { env.slackClientSecret = "changed" }
  assert.equal(await storage.getSlackHomeToken("TFIRST", signal()), null)
  env.slackClientSecret = "synthetic-secret"
  onRefresh = () => {}
  assert.equal(await storage.getSlackHomeToken("TFIRST", signal()), "rotated-bot")
  assert.equal(refreshes, 2)
})
