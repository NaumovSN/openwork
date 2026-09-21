import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR, freeInferenceWindow, managedModelCatalog, readFreeInferenceConfig } from "@openwork/types/den/inference"
import { DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, MEMBER_FREE_CHAT_PATH, MEMBER_FREE_STATUS_PATH, MEMBER_FREE_MODELS_PATH, desktopFreeProofMessage, type DesktopFreeProofClaims } from "@openwork/types/desktop-free-access"
import { readAutoConfig, freeRequestReservation } from "../src/free-config.js"
import { desktopFreeHash, verifyDesktopFreeProof } from "../src/desktop-free-proof.js"
import { createDesktopFreeVersionSource, desktopFreeVersionError } from "../src/desktop-free-version.js"
import { createAnonymousIdentities, issueAnonymousToken, verifyAnonymousToken, canonicalizeAnonymousAddress } from "../src/anonymous-identity.js"
import { prepareFreeRequest, readFreeRequest } from "../src/free-request.js"
import { FreeResponseReceipt, meterFreeResponse } from "../src/free-response.js"
import type { FreePrincipal } from "../src/free-principal.js"
import type { FreeAllowanceStore, FreeUsageReceipt } from "../src/free-allowance.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_DB_ENCRYPTION_KEY = "test-only-free-auto-encryption-key-000000000000"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/free_auto_test_unused"
const { registerAnonymousInferenceRoutes } = await import("../src/anonymous.js")
const { freeSettlementDecision } = await import("../src/free-allowance.js")

const config = readAutoConfig({ INFERENCE_FREE_ENABLED: "true", ANONYMOUS_INFERENCE_ENABLED: "true",
  INFERENCE_FREE_UPSTREAM_API_KEY: "fixture-upstream-key", ANONYMOUS_OPENROUTER_PROVIDER: "fixture-provider",
  ANONYMOUS_OPENROUTER_BYOK_ONLY_VERIFIED: "true", ANONYMOUS_TOKEN_SECRET: "test-only-token-secret-00000000000000000000",
  ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "test-only-accounting-key-1111111111111111111" })
const keys = generateKeyPairSync("ed25519")
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64")
const binding = { keyThumbprint: desktopFreeHash(Uint8Array.from(keys.publicKey.export({ format: "der", type: "spki" }))),
  appVersion: "1.2.3", platform: "darwin", arch: "arm64" } satisfies import("../src/desktop-free-proof.js").DesktopFreeBinding
const identities = createAnonymousIdentities(binding, "127.0.0.1", config)
const guest = () => issueAnonymousToken(identities, binding, config).token
const memberKey = `ow_auto_${"a".repeat(43)}`
const member: Extract<FreePrincipal, { kind: "member" }> = { kind: "member", id: createDenTypeId("user"), keyId: randomUUID(),
  memberId: createDenTypeId("member"), organizationId: createDenTypeId("organization") }
const prompt = JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }] })
function signed(path: string, authorization = "", body?: string, version = "1.2.3") {
  const method = body === undefined ? "GET" : "POST"
  const claims: DesktopFreeProofClaims = { version: 1, publicKey, appVersion: version, platform: "darwin", arch: "arm64", timestamp: Date.now(), nonce: randomUUID() }
  const message = desktopFreeProofMessage({ ...claims, method, path, bodyHash: desktopFreeHash(body ?? ""), authorizationHash: desktopFreeHash(authorization) })
  const proof = Buffer.from(JSON.stringify({ ...claims, signature: sign(null, Buffer.from(message), keys.privateKey).toString("base64url") })).toString("base64url")
  return new Request(`https://free.test${path}`, { method, body, headers: { "x-openwork-desktop-proof": proof,
    ...(authorization ? { authorization } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } })
}
function responseValue(id = "generation-1") {
  return { id, model: INFERENCE_FREE_MODEL_ID, choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
    usage: { cost: 0.00005, is_byok: true, cost_details: { upstream_inference_cost: 0.001 }, prompt_tokens: 10, completion_tokens: 2 } }
}
function fixture(overrides: Partial<import("../src/anonymous.js").FreeRouteDependencies> = {}) {
  const nonces = new Set<string>()
  const principals: FreePrincipal[] = []
  const receipts: Array<FreeUsageReceipt | null> = []
  const calls = { fetch: 0, session: 0, cancelled: 0 }
  const store: FreeAllowanceStore = {
    async consumeNonce(proof) { const key = `${proof.keyThumbprint}:${proof.nonce}`; if (nonces.has(key)) return "replay"; nonces.add(key); return "accepted" },
    async consumeSession() { calls.session++; return true },
    async read(principal) { return { state: "ready", code: null, allowance: { limitUsd: principal.kind === "member" ? 5 : 1,
      usedUsd: 0, reservedUsd: 0, remainingUsd: principal.kind === "member" ? 5 : 1, resetsAt: freeInferenceWindow().end.toISOString() } } },
    async reserve(principal, _ip, requestId, deadlineAt) { principals.push(principal); return { ok: true, requestId, deadlineAt } },
    async dispatch() { return true },
    async cancelUndispatched() { calls.cancelled++; return true },
    async settle(_id, receipt) { receipts.push(receipt); return true },
  }
  const app = new Hono()
  registerAnonymousInferenceRoutes(app, { config, store, latestVersion: async () => "1.2.3", clientAddress: () => "127.0.0.1",
    findMember: async (key) => key === memberKey ? member : null, defaultPinned: async () => true,
    fetch: async (url, init) => {
      calls.fetch++
      assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions")
      assert.equal(init?.redirect, "error")
      const headers = new Headers(init?.headers)
      assert.equal(headers.get("authorization"), "Bearer fixture-upstream-key")
      assert.equal(headers.get("x-openwork-desktop-proof"), null)
      return Response.json(responseValue())
    }, ...overrides })
  return { app, principals, receipts, calls, store }
}

test("free Auto remains disabled and member default is larger than device", () => {
  const defaults = readAutoConfig({})
  assert.equal(defaults.memberEnabled, false)
  assert.equal(defaults.anonymousEnabled, false)
  assert.equal(defaults.member.weeklyBudgetUsd, 5)
  assert.equal(defaults.deviceWeeklyAmount / INFERENCE_USAGE_CONVERSION_FACTOR, 1)
  assert.throws(() => readAutoConfig({ INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_WEEKLY_BUDGET_USD: "1" }))
  assert.throws(() => readFreeInferenceConfig({ INFERENCE_FREE_MODEL_ID: "paid-model" }))
  assert.deepEqual(managedModelCatalog().map((model) => model.modelID), [INFERENCE_FREE_MODEL_ID])
})

test("disabled endpoints do not verify metadata, write accounting, or dispatch", async () => {
  const f = fixture({ config: readAutoConfig({}), latestVersion: async () => { throw new Error("must not call") } })
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_SESSION_PATH, "", JSON.stringify({ installationId: randomUUID() })))).status, 503)
  assert.equal((await f.app.fetch(signed(MEMBER_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt))).status, 503)
  assert.equal(f.calls.fetch, 0)
  assert.equal(f.calls.session, 0)
  assert.equal(f.principals.length, 0)
})

test("proof binds raw body, actual bearer, route and installation metadata", () => {
  const request = signed(MEMBER_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt)
  const input = { header: request.headers.get("x-openwork-desktop-proof"), method: "POST", path: MEMBER_FREE_CHAT_PATH,
    bodyHash: desktopFreeHash(prompt), authorization: `Bearer ${memberKey}` }
  assert.ok(verifyDesktopFreeProof(input))
  assert.equal(verifyDesktopFreeProof({ ...input, bodyHash: desktopFreeHash(prompt + " ") }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, authorization: "Bearer another-member" }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, path: DESKTOP_FREE_CHAT_PATH }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, now: Date.now() + 61000 }), null)
})

test("guest token is bound to key, IP and metadata; mapped IPv6 cannot rotate IP identity", () => {
  const token = guest()
  assert.ok(verifyAnonymousToken(token, "127.0.0.1", config))
  assert.equal(verifyAnonymousToken(token, "127.0.0.2", config), null)
  assert.equal(verifyAnonymousToken(token.replace("v2", "v1"), "127.0.0.1", config), null)
  assert.equal(canonicalizeAnonymousAddress("::ffff:127.0.0.1"), "127.0.0.1")
  assert.equal(canonicalizeAnonymousAddress("::ffff:7f00:1"), "127.0.0.1")
})

test("session rejects authenticated downgrade and replay", async () => {
  const f = fixture()
  const body = JSON.stringify({ installationId: randomUUID() })
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_SESSION_PATH, `Bearer ${memberKey}`, body))).status, 401)
  const request = signed(DESKTOP_FREE_SESSION_PATH, "", body)
  assert.equal((await f.app.fetch(request.clone())).status, 200)
  assert.equal((await f.app.fetch(request)).status, 401)
  assert.equal(f.calls.session, 1)
})

test("member endpoint spends member allowance and guest endpoint remains device-scoped", async () => {
  const f = fixture()
  for (const [path, auth] of [[MEMBER_FREE_CHAT_PATH, `Bearer ${memberKey}`], [DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`]]) {
    const response = await f.app.fetch(signed(path, auth, prompt))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).usage.cost, undefined)
  }
  assert.deepEqual(f.principals.map((principal) => principal.kind), ["member", "installation"])
  assert.equal(f.principals[0].id, member.id)
  assert.equal(f.receipts.length, 2)
  assert.equal(f.receipts[0]?.amount, 105000)
  const status = await f.app.fetch(signed(MEMBER_FREE_STATUS_PATH, `Bearer ${memberKey}`))
  assert.equal((await status.json()).allowance.limitUsd, 5)
  const guestStatus = await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))
  const value = await guestStatus.json()
  assert.equal(value.allowance.limitUsd, 1)
  assert.deepEqual(value.catalog.map((item: { modelID: string }) => item.modelID), [INFERENCE_FREE_MODEL_ID])
})

test("member status carries org Auto pin policy while guests remain pinned and unpinning does not remove the model", async () => {
  const f = fixture({ defaultPinned: async () => false })
  const memberStatus = await f.app.fetch(signed(MEMBER_FREE_STATUS_PATH, `Bearer ${memberKey}`))
  assert.equal(memberStatus.status, 200)
  assert.equal((await memberStatus.json()).defaultPinned, false)
  const guestStatus = await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))
  assert.equal((await guestStatus.json()).defaultPinned, true)
  const catalog = await f.app.fetch(signed(MEMBER_FREE_MODELS_PATH, `Bearer ${memberKey}`))
  assert.equal(catalog.status, 200)
  assert.equal((await catalog.json()).data[0].id, INFERENCE_FREE_MODEL_ID)
  assert.equal(f.calls.fetch, 0)
  assert.equal(f.principals.length, 0)
  const failed = fixture({ defaultPinned: async () => { throw new Error("Policy unavailable") } })
  assert.equal((await failed.app.fetch(signed(MEMBER_FREE_STATUS_PATH, `Bearer ${memberKey}`))).status, 503)
})

test("bad member credentials never become guest requests or paid requests", async () => {
  const f = fixture()
  for (const token of [guest(), "ow_inf_existing-paid-key", "ow_auto_revoked"]) {
    assert.equal((await f.app.fetch(signed(MEMBER_FREE_CHAT_PATH, `Bearer ${token}`, prompt))).status, 401)
  }
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt))).status, 401)
  assert.equal(f.calls.fetch, 0)
  assert.equal(f.principals.length, 0)
})

test("version failure and unsupported model deny before reservation", async () => {
  const f = fixture()
  assert.equal((await f.app.fetch(signed(MEMBER_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt, "1.2.2"))).status, 426)
  assert.equal((await f.app.fetch(signed(MEMBER_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt.replace(INFERENCE_FREE_MODEL_ID, "paid-model")))).status, 400)
  assert.equal(f.principals.length, 0)
  assert.equal(f.calls.fetch, 0)
  const unavailable = fixture({ latestVersion: async () => null })
  assert.equal((await unavailable.app.fetch(signed(MEMBER_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt))).status, 503)
})

test("policy flip before dispatch cancels admission without upstream fallback", async () => {
  const base = fixture()
  const f = fixture({ store: { ...base.store, dispatch: async () => false } })
  assert.equal((await f.app.fetch(signed(MEMBER_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt))).status, 403)
  assert.equal(f.calls.fetch, 0)
})

test("uncertain upstream failure retains liability instead of refunding", async () => {
  const f = fixture({ fetch: async () => { throw new Error("uncertain transport") } })
  assert.equal((await f.app.fetch(signed(MEMBER_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt))).status, 502)
  assert.equal(f.calls.cancelled, 0)
  assert.deepEqual(f.receipts, [null])
})

test("request validation preserves tools but denies routing, media and expanded schemas", async () => {
  const value = { model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }] }
  const prepared = prepareFreeRequest(value, config)
  assert.deepEqual(JSON.parse(prepared.body).tools, value.tools)
  assert.equal(JSON.parse(prepared.body).provider.allow_fallbacks, false)
  assert.throws(() => prepareFreeRequest({ ...value, provider: { allow_fallbacks: true } }, config))
  assert.throws(() => prepareFreeRequest({ ...value, tools: [{ type: "function", function: { name: "run", parameters: { $ref: "remote" } } }] }, config))
  assert.throws(() => prepareFreeRequest({ ...value, messages: [{ role: "user", content: [{ type: "image_url", image_url: "remote" }] }] }, config))
  await assert.rejects(readFreeRequest(new Request("https://free.test", { method: "POST", headers: { "content-type": "application/json" }, body: prompt }), 1, new AbortController().signal))
})

test("terminal receipt requires matching identity, final choice and full BYOK cost", () => {
  const parser = new FreeResponseReceipt()
  parser.accept(responseValue())
  assert.equal(parser.complete()?.amount, 105000)
  assert.throws(() => parser.complete())
  const incomplete = new FreeResponseReceipt()
  incomplete.accept({ ...responseValue(), choices: [{ index: 0, finish_reason: null }] })
  assert.throws(() => incomplete.complete())
  const missingCost = new FreeResponseReceipt()
  missingCost.accept({ ...responseValue(), usage: {} })
  assert.equal(missingCost.complete(), null)
  assert.throws(() => new FreeResponseReceipt().accept({ ...responseValue(), model: "another-model" }))
})

test("SSE settles before DONE without waiting for EOF and releases upstream", async () => {
  const events: string[] = []
  const encoder = new TextEncoder()
  const text = `data: ${JSON.stringify(responseValue())}\n\ndata: [DONE]\n\n`
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text)) }, cancel() { events.push("cancel") } })
  const body = meterFreeResponse(upstream, { streaming: true, maxBytes: 10000, signal: new AbortController().signal,
    settle: async (receipt) => { assert.equal(receipt?.amount, 105000); events.push("settle") } })
  const reader = body.getReader()
  let output = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    const value = new TextDecoder().decode(chunk.value)
    if (value.includes("[DONE]")) assert.ok(events.includes("settle"))
    output += value
  }
  assert.ok(output.includes("[DONE]"))
  assert.deepEqual(events, ["settle", "cancel"])
})

test("usage followed by error or truncated EOF retains full hold", async () => {
  for (const suffix of ["", 'data: {"error":{"message":"interrupted"}}\n\n']) {
    const receipts: Array<FreeUsageReceipt | null> = []
    const upstream = new Response(`data: ${JSON.stringify(responseValue())}\n\n${suffix}`).body!
    const body = meterFreeResponse(upstream, { streaming: true, maxBytes: 10000, signal: new AbortController().signal,
      settle: async (receipt) => { receipts.push(receipt) } })
    await assert.rejects(new Response(body).text())
    assert.deepEqual(receipts, [null])
  }
})

test("unknown settlement retains conservative charge; actual overrun triggers safety block", () => {
  const held = { status: "dispatched", reserved_amount: freeRequestReservation(config), model_id: INFERENCE_FREE_MODEL_ID,
    max_input_tokens: config.maxInputTokens, max_output_tokens: config.maxCompletionTokens } satisfies Parameters<typeof freeSettlementDecision>[0]
  assert.deepEqual(freeSettlementDecision(held, null), { amount: held.reserved_amount, status: "retained", unsafe: false })
  assert.equal(freeSettlementDecision(held, { eventId: "event", model: INFERENCE_FREE_MODEL_ID, amount: held.reserved_amount + 1, inputTokens: 1, outputTokens: 1 })?.unsafe, true)
  assert.equal(freeSettlementDecision(held, { eventId: "event", model: "wrong", amount: 1, inputTokens: 1, outputTokens: 1 }), null)
})

test("latest stable floor is cached, malformed sources fail closed", async () => {
  let now = 0, calls = 0
  const source = createDesktopFreeVersionSource({ url: "https://metadata.test/v1/app-version", now: () => now,
    fetch: async () => { calls++; return Response.json({ latestAppVersion: "1.2.3" }) } })
  assert.equal(await source(), "1.2.3")
  assert.equal(await source(), "1.2.3")
  assert.equal(calls, 1)
  now = 300001
  assert.equal(await source(), "1.2.3")
  assert.equal(calls, 2)
  assert.equal(desktopFreeVersionError("1.2.3-alpha", "1.2.3")?.code, "desktop_update_required")
  assert.equal(desktopFreeVersionError("1.2.3", null)?.code, "desktop_version_unavailable")
})
