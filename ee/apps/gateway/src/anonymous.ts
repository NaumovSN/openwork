import { randomBytes } from "node:crypto"
import type { Context, Hono } from "hono"
import { z } from "zod"
import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH,
  DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH, MEMBER_FREE_STATUS_PATH, MEMBER_FREE_MODELS_PATH,
  MEMBER_FREE_CHAT_PATH, type DesktopFreeAccessStatus,
} from "@openwork/types/desktop-free-access"
import { managedModelCatalog } from "@openwork/types/den/inference"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { createAnonymousIdentities, issueAnonymousToken, resolveAnonymousClientAddress, verifyAnonymousToken } from "./anonymous-identity.js"
import { createFreeAllowanceStore, type FreeAllowanceStore } from "./free-allowance.js"
import { type AutoConfig } from "./free-config.js"
import { findMemberFreePrincipal, readFreePrincipalDefaultPinned, type FreePrincipal } from "./free-principal.js"
import { checkDesktopFreeRequest, desktopFreeGateError, type DesktopFreeGateDependencies } from "./desktop-free-access.js"
import { desktopFreeHash } from "./desktop-free-proof.js"
import { createDesktopFreeVersionSource } from "./desktop-free-version.js"
import { prepareFreeRequest, readFreeRequest, FreeRequestError } from "./free-request.js"
import { meterFreeResponse } from "./free-response.js"
import { env } from "./env.js"

const sessionSchema = z.strictObject({ installationId: z.string().uuid() })
export type FreeRouteDependencies = {
  config: AutoConfig;
  store: FreeAllowanceStore;
  fetch: typeof fetch;
  latestVersion: DesktopFreeGateDependencies["latestVersion"];
  clientAddress: (c: Context) => string | null;
  findMember: typeof findMemberFreePrincipal;
  defaultPinned: typeof readFreePrincipalDefaultPinned;
}
function defaults(): FreeRouteDependencies {
  const config = env.freeAuto
  return { config, store: createFreeAllowanceStore(config), fetch: createInferenceEgressFetch(),
    latestVersion: createDesktopFreeVersionSource({ url: config.versionUrl }),
    clientAddress: (c) => resolveAnonymousClientAddress(c, config), findMember: findMemberFreePrincipal, defaultPinned: readFreePrincipalDefaultPinned }
}
function bearer(request: Request) {
  if (["x-api-key", "x-goog-api-key", "api-key"].some((name) => request.headers.has(name))) return null
  return /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null
}
function errorResponse(error: unknown) {
  if (error instanceof FreeRequestError) return desktopFreeGateError(error.status, error.code, error.message)
  if (error instanceof ManagedModelsPolicyError) return desktopFreeGateError(error.status, error.code, error.message)
  return desktopFreeGateError(503, "anonymous_unavailable")
}
export function registerAnonymousInferenceRoutes(app: Hono, dependencies = defaults()) {
  const { config, store } = dependencies
  const gateDependencies = { latestVersion: dependencies.latestVersion, consumeNonce: store.consumeNonce }
  const route = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try { return await handler(c) } catch (error) { return errorResponse(error) }
  }
  app.post(DESKTOP_FREE_SESSION_PATH, route(async (c) => {
    if (!config.anonymousEnabled) return desktopFreeGateError(503, "anonymous_unavailable")
    if (c.req.raw.headers.has("authorization") || new URL(c.req.url).search) return desktopFreeGateError(401, "invalid_anonymous_token")
    const address = dependencies.clientAddress(c)
    if (!address) return desktopFreeGateError(503, "anonymous_unavailable")
    const parsed = await readFreeRequest(c.req.raw, 4096, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]))
    if (!sessionSchema.safeParse(parsed.value).success) return desktopFreeGateError(400, "invalid_request")
    const unboundIp = createAnonymousIdentities({ keyThumbprint: "0".repeat(64) }, address, config).ipHash
    const gate = await checkDesktopFreeRequest(c.req.raw, parsed.bodyHash, unboundIp, gateDependencies)
    if (gate.error) return gate.error
    if (gate.versionError) return Response.json({ error: gate.versionError }, { status: gate.versionError.code === "desktop_update_required" ? 426 : 503, headers: { "cache-control": "no-store" } })
    const identities = createAnonymousIdentities(gate.proof, address, config)
    if (!await store.consumeSession(identities.ipHash, identities.installationHash)) return desktopFreeGateError(429, "anonymous_capacity_exceeded")
    return c.json({ ...issueAnonymousToken(identities, gate.proof, config), model: DESKTOP_FREE_MODEL_ID }, 200, { "cache-control": "no-store" })
  }))

  async function authenticate(c: Context, member: boolean, bodyHash: string) {
    if (!(member ? config.memberEnabled : config.anonymousEnabled)) return { error: desktopFreeGateError(503, "anonymous_unavailable") }
    const token = bearer(c.req.raw)
    const address = dependencies.clientAddress(c)
    if (!token || !address) return { error: desktopFreeGateError(401, member ? "invalid_free_member_key" : "invalid_anonymous_token") }
    let principal: FreePrincipal
    const guest = member ? null : verifyAnonymousToken(token, address, config)
    if (member) {
      const value = await dependencies.findMember(token)
      if (!value) return { error: desktopFreeGateError(401, "invalid_free_member_key") }
      principal = value
    } else {
      if (!guest) return { error: desktopFreeGateError(401, "invalid_anonymous_token") }
      principal = { kind: "installation", id: guest.installationHash }
    }
    const ipHash = createAnonymousIdentities({ keyThumbprint: "0".repeat(64) }, address, config).ipHash
    const gate = await checkDesktopFreeRequest(c.req.raw, bodyHash, ipHash, gateDependencies, guest ?? undefined)
    if (gate.error) return { error: gate.error }
    return { ...gate, principal, ipHash }
  }

  for (const member of [false, true]) {
    const statusPath = member ? MEMBER_FREE_STATUS_PATH : DESKTOP_FREE_STATUS_PATH
    const modelsPath = member ? MEMBER_FREE_MODELS_PATH : DESKTOP_FREE_MODELS_PATH
    const chatPath = member ? MEMBER_FREE_CHAT_PATH : DESKTOP_FREE_CHAT_PATH
    app.get(statusPath, route(async (c) => {
      if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
      const auth = await authenticate(c, member, desktopFreeHash(""))
      if (auth.error) return auth.error
      const status: DesktopFreeAccessStatus = { state: "unavailable", code: "anonymous_unavailable", currentVersion: auth.proof.appVersion,
        minimumVersion: auth.minimumVersion, providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID,
        allowance: null, catalog: managedModelCatalog(), defaultPinned: auth.principal.kind === "installation" ? true : await dependencies.defaultPinned(auth.principal) }
      if (auth.versionError) {
        status.state = auth.versionError.code === "desktop_update_required" ? "update_required" : "unavailable"
        status.code = auth.versionError.code
      } else Object.assign(status, await store.read(auth.principal, auth.ipHash))
      return c.json(status, 200, { "cache-control": "no-store" })
    }))
    app.get(modelsPath, route(async (c) => {
      if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
      const auth = await authenticate(c, member, desktopFreeHash(""))
      if (auth.error) return auth.error
      if (auth.versionError) return Response.json({ error: auth.versionError }, { status: auth.versionError.code === "desktop_update_required" ? 426 : 503, headers: { "cache-control": "no-store" } })
      return c.json({ object: "list", data: [{ id: DESKTOP_FREE_MODEL_ID, object: "model", created: 0, owned_by: "openwork" }] }, 200, { "cache-control": "no-store" })
    }))
    app.post(chatPath, route(async (c) => {
      if (!(member ? config.memberEnabled : config.anonymousEnabled)) return desktopFreeGateError(503, "anonymous_unavailable")
      if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
      const deadlineAt = Date.now() + config.requestTimeoutMs
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(config.requestTimeoutMs)])
      const parsed = await readFreeRequest(c.req.raw, config.maxBodyBytes, signal)
      const auth = await authenticate(c, member, parsed.bodyHash)
      if (auth.error) return auth.error
      if (auth.versionError) return Response.json({ error: auth.versionError }, { status: auth.versionError.code === "desktop_update_required" ? 426 : 503, headers: { "cache-control": "no-store" } })
      const prepared = prepareFreeRequest(parsed.value, config)
      signal.throwIfAborted()
      const requestId = randomBytes(16).toString("hex")
      const admission = await store.reserve(auth.principal, auth.ipHash, requestId, deadlineAt)
      if (!admission.ok) return desktopFreeGateError(admission.code === "free_request_in_progress" ? 423 : 429, admission.code)
      let dispatched = false
      try {
        signal.throwIfAborted()
        if (!await store.dispatch(requestId, auth.principal, admission.deadlineAt)) return desktopFreeGateError(403, "free_principal_rejected")
        dispatched = true
        signal.throwIfAborted()
        const response = await dependencies.fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST", redirect: "error", signal,
          headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: prepared.stream ? "text/event-stream" : "application/json", "x-title": "OpenWork Auto" },
          body: prepared.body,
        })
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
        if (!response.ok || !response.body || contentType !== (prepared.stream ? "text/event-stream" : "application/json")) {
          controller.abort()
          await response.body?.cancel().catch(() => undefined)
          await store.settle(requestId, null)
          return desktopFreeGateError(502, "free_inference_upstream_error", "Auto did not finish. Unconfirmed usage is retained conservatively.")
        }
        const body = meterFreeResponse(response.body, { streaming: prepared.stream, maxBytes: config.maxResponseBytes, signal,
          settle: async (receipt) => { await store.settle(requestId, receipt) } })
        return new Response(body, { headers: { "content-type": contentType, "cache-control": "no-store", "x-openwork-request-id": requestId } })
      } catch {
        controller.abort()
        const cancelled = !dispatched && await store.cancelUndispatched(requestId).catch(() => false)
        if (!cancelled) await store.settle(requestId, null).catch(() => undefined)
        return desktopFreeGateError(502, "free_inference_upstream_error", cancelled
          ? "Auto was not dispatched. No allowance was consumed." : "Auto did not finish. Unconfirmed usage is retained conservatively.")
      }
    }))
  }
  for (const prefix of ["/api/anonymous", "/api/free"]) {
    app.all(prefix, () => desktopFreeGateError(404, "not_found"))
    app.all(`${prefix}/*`, () => desktopFreeGateError(404, "not_found"))
  }
}
