import { and, count, eq, inArray, lte, sql } from "@openwork-ee/den-db/drizzle"
import {
  DesktopFreeProofNonceTable as Nonce, InferenceFreeControlTable as Control,
  InferenceFreeUsageBucketTable as Bucket, InferenceFreeReservationTable as Reservation,
  InferenceFreeReservationChargeTable as Charge, InferenceFreeRateBucketTable as Rate,
} from "@openwork-ee/den-db"
import { freeInferenceWindow, INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { DESKTOP_FREE_PROOF_CLOCK_SKEW_MS, type DesktopFreeAccessStatus } from "@openwork/types/desktop-free-access"
import type { DesktopFreeBinding } from "./desktop-free-proof.js"
import { freeIdentityHash, freePrincipalHash, memberFreePrincipalAllowed, type FreePrincipal } from "./free-principal.js"
import { freeRequestReservation, type AutoConfig } from "./free-config.js"
import { db } from "./db.js"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Held = typeof Reservation.$inferSelect
export type FreeUsageReceipt = { eventId: string; model: string; amount: number; inputTokens: number; outputTokens: number }
export type FreeAdmission = { ok: true; requestId: string; deadlineAt: number } | { ok: false; code: string }
const controlId = "free-auto"
const active = ["held", "dispatched"] satisfies Held["status"][]

async function lock(tx: Tx) {
  await tx.insert(Control).values({ id: controlId }).onDuplicateKeyUpdate({ set: { id: sql`${Control.id}` } })
  const [control] = await tx.select({ blocked: Control.blocked, nowMs: sql<number>`unix_timestamp(current_timestamp(3)) * 1000` })
    .from(Control).where(eq(Control.id, controlId)).for("update")
  if (!control) throw new Error("Free accounting unavailable")
  return { blocked: control.blocked, now: new Date(Number(control.nowMs)) }
}
function stableId(parts: string[]) { return freeIdentityHash("free", parts.join(":")) }
function specs(principal: FreePrincipal, ipHash: string, config: AutoConfig, now: Date) {
  const weekly = freeInferenceWindow(now)
  const daily = { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) }
  const monthly = { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) }
  const values: Array<{ scope: typeof Bucket.$inferSelect.scope; identity: string; window: typeof Bucket.$inferSelect.window_type; start: Date; end: Date; limit: number }> = [
    { scope: principal.kind, identity: freePrincipalHash(principal), window: "weekly", ...weekly, limit: principal.kind === "member" ? config.member.weeklyLimitAmount : config.deviceWeeklyAmount },
    { scope: "ip", identity: ipHash, window: "daily", ...daily, limit: config.ipDailyAmount },
    { scope: "global", identity: "global", window: "daily", ...daily, limit: config.globalDailyAmount },
    { scope: "global", identity: "global", window: "monthly", ...monthly, limit: config.globalMonthlyAmount },
  ]
  return values.map((value) => ({ ...value, id: freeUsageBucketId(value.scope, value.identity, value.window, value.start) }))
}
export function freeUsageBucketId(scope: string, identity: string, window: string, start: Date) {
  return stableId(["usage", scope, identity, window, start.toISOString()])
}
async function consumeRates(tx: Tx, limits: Array<{ kind: string; identity: string; limit: number }>, now: Date) {
  const start = new Date(now)
  start.setUTCMinutes(0, 0, 0)
  const specs = limits.map((value) => ({ ...value, id: stableId(["rate", value.kind, value.identity, start.toISOString()]) }))
  for (const spec of specs) {
    const [row] = await tx.select().from(Rate).where(eq(Rate.id, spec.id)).limit(1)
    if (row && row.used_amount >= spec.limit) return false
  }
  for (const spec of specs) await tx.insert(Rate).values({ id: spec.id, used_amount: 1, expires_at: new Date(start.getTime() + 3600000) })
    .onDuplicateKeyUpdate({ set: { used_amount: sql`${Rate.used_amount} + 1` } })
  return true
}

export function freeSettlementDecision(reservation: Pick<Held, "status" | "reserved_amount" | "max_input_tokens" | "max_output_tokens" | "model_id">, receipt: FreeUsageReceipt | null) {
  if (receipt === null) return { amount: reservation.reserved_amount, status: "retained", unsafe: false } as const
  if (!receipt.eventId || receipt.model !== reservation.model_id || ![receipt.amount, receipt.inputTokens, receipt.outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) return null
  return { amount: receipt.amount, status: "settled", unsafe: receipt.amount > reservation.reserved_amount
    || receipt.inputTokens > reservation.max_input_tokens || receipt.outputTokens > reservation.max_output_tokens } as const
}
async function finish(tx: Tx, reservation: Held, receipt: FreeUsageReceipt | null, cancel = false) {
  if (reservation.status !== "held" && reservation.status !== "dispatched") return false
  if (cancel && reservation.status !== "held") return false
  const decision = cancel ? { amount: 0, status: "cancelled", unsafe: false } as const : freeSettlementDecision(reservation, receipt)
  if (!decision) return false
  const charges = await tx.select().from(Charge).where(eq(Charge.request_id, reservation.request_id))
  if (charges.length !== 4) throw new Error("Free accounting charge invariant")
  for (const charge of charges) {
    const [bucket] = await tx.select().from(Bucket).where(eq(Bucket.id, charge.bucket_id)).limit(1).for("update")
    if (!bucket || bucket.reserved_amount < charge.reserved_amount || charge.reserved_amount !== reservation.reserved_amount
      || !Number.isSafeInteger(bucket.used_amount + decision.amount)) throw new Error("Free accounting bucket invariant")
    await tx.update(Bucket).set({ reserved_amount: bucket.reserved_amount - charge.reserved_amount,
      used_amount: bucket.used_amount + decision.amount }).where(eq(Bucket.id, bucket.id))
  }
  if (decision.unsafe) await tx.update(Control).set({ blocked: true }).where(eq(Control.id, controlId))
  await tx.update(Reservation).set({ status: decision.status, actual_amount: decision.amount,
    external_event_id: receipt?.eventId ?? null }).where(eq(Reservation.request_id, reservation.request_id))
  return true
}
async function reap(tx: Tx, now: Date) {
  const expired = await tx.select().from(Reservation).where(and(inArray(Reservation.status, active), lte(Reservation.expires_at, now))).limit(100).for("update")
  for (const reservation of expired) await finish(tx, reservation, null)
}

export function createFreeAllowanceStore(config: AutoConfig, database = db) {
  return {
    async consumeNonce(proof: DesktopFreeBinding & { nonce: string; timestamp: number }, ipHash: string): Promise<"accepted" | "replay" | "unavailable"> {
      return database.transaction(async (tx) => {
        const { now } = await lock(tx)
        if (Math.abs(now.getTime() - proof.timestamp) > DESKTOP_FREE_PROOF_CLOCK_SKEW_MS) return "unavailable"
        await tx.delete(Nonce).where(lte(Nonce.expires_at, now)).limit(1000)
        await tx.delete(Rate).where(lte(Rate.expires_at, now)).limit(1000)
        const id = stableId(["nonce", proof.keyThumbprint, proof.nonce.toLowerCase()])
        const [existing] = await tx.select().from(Nonce).where(eq(Nonce.id, id)).limit(1)
        if (existing) return "replay"
        if (!await consumeRates(tx, [{ kind: "proof-ip", identity: ipHash, limit: 1200 },
          { kind: "proof-global", identity: "global", limit: 40000 }], now)) return "unavailable"
        const [total] = await tx.select({ amount: count() }).from(Nonce)
        if (Number(total?.amount ?? 0) >= 50000) return "unavailable"
        await tx.insert(Nonce).values({ id, expires_at: new Date(proof.timestamp + DESKTOP_FREE_PROOF_CLOCK_SKEW_MS + 1000) })
        return "accepted"
      })
    },
    async consumeSession(ipHash: string, installationHash: string) {
      return database.transaction(async (tx) => {
        const { blocked, now } = await lock(tx)
        return !blocked && await consumeRates(tx, [{ kind: "session-ip", identity: ipHash, limit: 60 },
          { kind: "session-installation", identity: installationHash, limit: 12 },
          { kind: "session-global", identity: "global", limit: 10000 }], now)
      })
    },
    async read(principal: FreePrincipal, ipHash: string): Promise<Pick<DesktopFreeAccessStatus, "state" | "code" | "allowance">> {
      return database.transaction(async (tx) => {
        const { blocked, now } = await lock(tx)
        if (!await memberFreePrincipalAllowed(principal, tx)) return { state: "unavailable", code: "free_principal_rejected", allowance: null }
        await reap(tx, now)
        const buckets = specs(principal, ipHash, config, now)
        let allowance: DesktopFreeAccessStatus["allowance"] = null
        let limited = false, sharedLimited = false
        for (const spec of buckets) {
          const [row] = await tx.select().from(Bucket).where(eq(Bucket.id, spec.id)).limit(1)
          const limit = row?.limit_amount ?? spec.limit
          const used = row?.used_amount ?? 0, reserved = row?.reserved_amount ?? 0
          const cannotFit = used + reserved + freeRequestReservation(config) > limit
          if (spec.scope === "member" || spec.scope === "installation") {
            limited = cannotFit
            allowance = { limitUsd: limit / INFERENCE_USAGE_CONVERSION_FACTOR, usedUsd: used / INFERENCE_USAGE_CONVERSION_FACTOR,
              reservedUsd: reserved / INFERENCE_USAGE_CONVERSION_FACTOR, remainingUsd: Math.max(0, limit - used - reserved) / INFERENCE_USAGE_CONVERSION_FACTOR,
              resetsAt: spec.end.toISOString() }
          } else sharedLimited ||= cannotFit
        }
        if (blocked) return { state: "unavailable", code: "free_accounting_blocked", allowance }
        const [pending] = await tx.select({ id: Reservation.request_id }).from(Reservation)
          .where(and(eq(Reservation.principal_hash, freePrincipalHash(principal)), inArray(Reservation.status, active))).limit(1)
        if (pending) return { state: "unavailable", code: "free_request_in_progress", allowance }
        if (limited) return { state: "exhausted", code: "anonymous_reservation_does_not_fit", allowance }
        if (sharedLimited) return { state: "unavailable", code: "anonymous_capacity_exceeded", allowance }
        return { state: "ready", code: null, allowance }
      })
    },
    async reserve(principal: FreePrincipal, ipHash: string, requestId: string, deadlineAt: number): Promise<FreeAdmission> {
      return database.transaction(async (tx) => {
        const { blocked, now } = await lock(tx)
        if (blocked || now.getTime() >= deadlineAt || !await memberFreePrincipalAllowed(principal, tx)) return { ok: false, code: "free_principal_rejected" }
        await reap(tx, now)
        const principalHash = freePrincipalHash(principal)
        const [pending] = await tx.select({ id: Reservation.request_id }).from(Reservation)
          .where(and(eq(Reservation.principal_hash, principalHash), inArray(Reservation.status, active))).limit(1)
        if (pending) return { ok: false, code: "free_request_in_progress" }
        const [inflight] = await tx.select({ amount: count() }).from(Reservation).where(inArray(Reservation.status, active))
        if (Number(inflight?.amount ?? 0) >= config.globalInflight) return { ok: false, code: "anonymous_capacity_exceeded" }
        if (!await consumeRates(tx, [{ kind: "request-principal", identity: principalHash, limit: 60 },
          { kind: "request-ip", identity: ipHash, limit: 300 }, { kind: "request-global", identity: "global", limit: 10000 }], now)) return { ok: false, code: "anonymous_capacity_exceeded" }
        const amount = freeRequestReservation(config)
        const rows: Array<typeof Bucket.$inferSelect> = []
        for (const spec of specs(principal, ipHash, config, now)) {
          await tx.insert(Bucket).values({ id: spec.id, scope: spec.scope, identity_hash: spec.identity, window_type: spec.window,
            window_start_at: spec.start, window_end_at: spec.end, limit_amount: spec.limit }).onDuplicateKeyUpdate({ set: { id: sql`${Bucket.id}` } })
          const [row] = await tx.select().from(Bucket).where(eq(Bucket.id, spec.id)).limit(1).for("update")
          if (!row || row.blocked) return { ok: false, code: "free_accounting_blocked" }
          if (!Number.isSafeInteger(row.used_amount + row.reserved_amount + amount) || row.used_amount + row.reserved_amount + amount > row.limit_amount) {
            return { ok: false, code: spec.scope === "global" || spec.scope === "ip" ? "anonymous_capacity_exceeded" : "anonymous_limit_exceeded" }
          }
          rows.push(row)
        }
        const expiresAt = Math.min(deadlineAt, now.getTime() + config.requestTimeoutMs)
        if (Date.now() >= expiresAt) return { ok: false, code: "anonymous_unavailable" }
        await tx.insert(Reservation).values({ request_id: requestId, principal_hash: principalHash,
          key_id: principal.kind === "member" ? principal.keyId : null,
          organization_id: principal.kind === "member" ? principal.organizationId : null, model_id: INFERENCE_FREE_MODEL_ID,
          reserved_amount: amount, max_input_tokens: config.maxInputTokens, max_output_tokens: config.maxCompletionTokens,
          expires_at: new Date(expiresAt + 30000) })
        for (const row of rows) {
          await tx.update(Bucket).set({ reserved_amount: row.reserved_amount + amount }).where(eq(Bucket.id, row.id))
          await tx.insert(Charge).values({ id: stableId([requestId, row.id]), request_id: requestId, bucket_id: row.id, reserved_amount: amount })
        }
        return { ok: true, requestId, deadlineAt: expiresAt }
      })
    },
    async dispatch(requestId: string, principal: FreePrincipal, deadlineAt: number) {
      return database.transaction(async (tx) => {
        const { blocked, now } = await lock(tx)
        const [reservation] = await tx.select().from(Reservation).where(eq(Reservation.request_id, requestId)).limit(1).for("update")
        if (!reservation || reservation.status !== "held" || reservation.principal_hash !== freePrincipalHash(principal)
          || reservation.key_id !== (principal.kind === "member" ? principal.keyId : null)) return false
        if (blocked || now.getTime() >= deadlineAt || !await memberFreePrincipalAllowed(principal, tx)) {
          await finish(tx, reservation, null, true)
          return false
        }
        await tx.update(Reservation).set({ status: "dispatched" }).where(eq(Reservation.request_id, requestId))
        return true
      })
    },
    async cancelUndispatched(requestId: string) {
      return database.transaction(async (tx) => {
        await lock(tx)
        const [reservation] = await tx.select().from(Reservation).where(eq(Reservation.request_id, requestId)).limit(1).for("update")
        return reservation ? finish(tx, reservation, null, true) : false
      })
    },
    async settle(requestId: string, receipt: FreeUsageReceipt | null) {
      return database.transaction(async (tx) => {
        await lock(tx)
        const [reservation] = await tx.select().from(Reservation).where(eq(Reservation.request_id, requestId)).limit(1).for("update")
        if (!reservation) return false
        if (reservation.status === "retained") {
          const decision = freeSettlementDecision(reservation, receipt)
          if (decision?.unsafe) await tx.update(Control).set({ blocked: true }).where(eq(Control.id, controlId))
          return false
        }
        return finish(tx, reservation, receipt)
      })
    },
  }
}
export type FreeAllowanceStore = ReturnType<typeof createFreeAllowanceStore>
