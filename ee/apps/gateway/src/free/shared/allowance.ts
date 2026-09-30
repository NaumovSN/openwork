import { eq, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  DesktopFreeProofNonceTable as Nonce, AnonymousInferenceIdentityTable as Identity, AnonymousInferenceRateBucketTable as Rate,
  AnonymousInferenceUsageBucketTable as GuestBucket, AnonymousInferenceUsageTable as GuestUsage,
  InferenceFreeUsageBucketTable as MemberBucket, InferenceFreeUsageTable as MemberUsage,
} from "@openwork-ee/den-db"
import { freeInferenceWindow, INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { DESKTOP_FREE_PROOF_CLOCK_SKEW_MS, type DesktopFreeAccessStatus } from "@openwork/free-auto"
import { rampedDeviceAmount } from "@openwork/free-auto/accounting"
import { freeIdentityHash, freePrincipalHash, memberFreePrincipalAllowed, type FreePrincipal } from "./principal.js"
import type { AutoConfig } from "./config.js"
import { db, freeAutoDatabase } from "../../db.js"
import { createFreeCapacity, type FreeCapacity } from "./capacity.js"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type FreeAllowanceFamily = "anonymous" | "member"
export type FreeUsageReceipt = { eventId: string; model: string; amount: number; inputTokens: number; outputTokens: number }
/** A usage window, like one paid Models limit policy window. */
export type FreeWindow = { id: string; scope: "member" | "installation" | "global"; identity: string;
  window: "weekly" | "daily" | "monthly"; start: Date; end: Date; limit: number }
export type FreeAdmission = { ok: true; windows: FreeWindow[] } | { ok: false; code: string }

export function freeUsageBucketId(scope: string, identity: string, window: string, start: Date) {
  return freeIdentityHash("free", ["usage", scope, identity, window, start.toISOString()].join(":"))
}
function stableId(parts: string[]) { return freeIdentityHash("free", parts.join(":")) }
/** A receipt counts only if it is for the free model and its numbers are sane; otherwise the estimate is charged. */
export function validFreeReceipt(receipt: FreeUsageReceipt | null): receipt is FreeUsageReceipt {
  return Boolean(receipt && receipt.eventId && receipt.eventId.length <= 255 && receipt.model === INFERENCE_FREE_MODEL_ID
    && [receipt.amount, receipt.inputTokens, receipt.outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0))
}
function isDuplicate(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "ER_DUP_ENTRY") return true
  }
  return false
}

class NewIdentityCapped extends Error {}

let sharedCapacity: FreeCapacity | undefined
/** One limit per process, shared by guests and members. */
function processCapacity(config: AutoConfig) {
  sharedCapacity ??= createFreeCapacity({ maxActive: config.maxConcurrent, maxQueued: config.maxQueued })
  return sharedCapacity
}

/**
 * Free Auto accounting, on the paid Models pattern: before a request, refuse only when a window's used total has
 * reached its limit; after it, record the real cost once (keyed on OpenAI's completion id) and add it to each
 * window. Nothing is held up front, so parallel requests from one person run exactly as they do on paid Models.
 */
export function createFreeAllowanceStore(config: AutoConfig, family: FreeAllowanceFamily, database: typeof db = freeAutoDatabase(), capacity: FreeCapacity = processCapacity(config)) {
  const owns = (principal: FreePrincipal) => principal.kind === (family === "member" ? "member" : "installation")

  /**
   * Every signed guest request is a heartbeat: the time since the previous one is credited as
   * active time, unless the gap is long enough to mean the app was closed. Returns the total.
   */
  async function identityActivity(tx: Tx, principal: FreePrincipal, now: Date) {
    if (principal.kind !== "installation") return 0
    // Insert first, then lock the row that now exists: a locking read of a missing row takes a gap lock that deadlocks parallel requests.
    await tx.insert(Identity).values({ id: principal.id, first_seen_at: now, last_seen_at: now, active_ms: 0 }).onDuplicateKeyUpdate({ set: { id: sql`${Identity.id}` } })
    const [existing] = await tx.select().from(Identity).where(eq(Identity.id, principal.id)).limit(1).for("update")
    if (!existing) throw new Error("Free accounting identity unavailable")
    const gap = now.getTime() - existing.last_seen_at.getTime()
    const activeMs = existing.active_ms + (gap > 0 && gap <= config.activityMaxGapMs ? gap : 0)
    if (gap > 0) await tx.update(Identity).set({ last_seen_at: now, active_ms: activeMs }).where(eq(Identity.id, principal.id))
    return activeMs
  }
  /** Members: their weekly allowance only. Guests: the machine's weekly allowance, which grows with time the app is open, and the global daily and monthly caps. */
  function windows(principal: FreePrincipal, now: Date, activeMs: number): FreeWindow[] {
    const weekly = freeInferenceWindow(now)
    const identity = freePrincipalHash(principal)
    const values: Array<Omit<FreeWindow, "id">> = principal.kind === "member"
      ? [{ scope: "member", identity, window: "weekly", ...weekly, limit: config.member.weeklyLimitAmount }]
      : [
          { scope: "installation", identity, window: "weekly", ...weekly, limit: rampedDeviceAmount(config, activeMs) },
          { scope: "global", identity: "global", window: "daily", start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
            end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)), limit: config.globalDailyAmount },
          { scope: "global", identity: "global", window: "monthly", start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
            end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)), limit: config.globalMonthlyAmount },
        ]
    return values.map((value) => ({ ...value, id: freeUsageBucketId(value.scope, value.identity, value.window, value.start) }))
  }
  async function used(tx: Tx, window: FreeWindow) {
    const table = family === "member" ? MemberBucket : GuestBucket
    const [row] = await tx.select({ used: table.used_amount }).from(table).where(eq(table.id, window.id)).limit(1)
    return row?.used ?? 0
  }
  async function addUsage(tx: Tx, window: FreeWindow, amount: number) {
    const row = { id: window.id, identity_hash: window.identity, window_start_at: window.start, window_end_at: window.end, limit_amount: window.limit, used_amount: amount }
    if (family === "member") {
      await tx.insert(MemberBucket).values(row).onDuplicateKeyUpdate({ set: { used_amount: sql`${MemberBucket.used_amount} + ${amount}`, limit_amount: window.limit } })
    } else {
      await tx.insert(GuestBucket).values({ ...row, scope: window.scope as "installation" | "global", window_type: window.window })
        .onDuplicateKeyUpdate({ set: { used_amount: sql`${GuestBucket.used_amount} + ${amount}`, limit_amount: window.limit } })
    }
  }
  /** Walks the windows in order: the personal allowance first, then the shared caps. */
  async function check(tx: Tx, principal: FreePrincipal, now: Date) {
    const all = windows(principal, now, await identityActivity(tx, principal, now))
    let allowance: DesktopFreeAccessStatus["allowance"] = null
    let code: string | null = null
    for (const window of all) {
      const total = await used(tx, window)
      if (window.scope !== "global") allowance = { limitUsd: window.limit / INFERENCE_USAGE_CONVERSION_FACTOR, usedUsd: total / INFERENCE_USAGE_CONVERSION_FACTOR,
        remainingUsd: Math.max(0, window.limit - total) / INFERENCE_USAGE_CONVERSION_FACTOR, resetsAt: window.end.toISOString() }
      if (!code && total >= window.limit) code = window.scope === "global" ? "anonymous_capacity_exceeded" : "anonymous_limit_exceeded"
    }
    return { windows: all, allowance, code }
  }

  return {
    family,
    /** A signed desktop proof is good once, and only close to the Gateway's clock. */
    async consumeNonce(proof: { keyThumbprint: string; nonce: string; timestamp: number }): Promise<"accepted" | "replay" | "unavailable"> {
      if (family !== "anonymous") return "unavailable"
      const now = new Date()
      if (Math.abs(now.getTime() - proof.timestamp) > DESKTOP_FREE_PROOF_CLOCK_SKEW_MS) return "unavailable"
      return capacity.run(async () => {
        await database.delete(Nonce).where(lte(Nonce.expires_at, now)).limit(1000).catch(() => undefined)
        // The primary key is the replay check: a second insert of the same signature fails.
        try {
          await database.insert(Nonce).values({ id: stableId(["nonce", proof.keyThumbprint, proof.nonce.toLowerCase()]),
            expires_at: new Date(proof.timestamp + DESKTOP_FREE_PROOF_CLOCK_SKEW_MS + 1000) })
        } catch (error) {
          if (isDuplicate(error)) return "replay"
          throw error
        }
        return "accepted"
      })
    },
    /** Starts a guest session. A machine never seen before counts against its IP's daily cap on new machines. */
    async consumeSession(ipHash: string, installationHash: string): Promise<"accepted" | "new_identity_capped"> {
      if (family !== "anonymous") throw new Error("Guest sessions only")
      const now = new Date()
      return capacity.run(async () => {
        await database.delete(Rate).where(lte(Rate.expires_at, now)).limit(1000).catch(() => undefined)
        try {
          return await database.transaction(async (tx) => {
            const [known] = await tx.select({ id: Identity.id }).from(Identity).where(eq(Identity.id, installationHash)).limit(1)
            if (!known) {
              // Count first, then check; a machine over the cap rolls the count back.
              const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
              const id = stableId(["rate", "new-identity-ip", ipHash, start.toISOString()])
              await tx.insert(Rate).values({ id, used_amount: 1, expires_at: new Date(start.getTime() + 86400000) })
                .onDuplicateKeyUpdate({ set: { used_amount: sql`${Rate.used_amount} + 1` } })
              const [row] = await tx.select().from(Rate).where(eq(Rate.id, id)).limit(1)
              if (!row || row.used_amount > config.ipNewIdentitiesPerDay) throw new NewIdentityCapped()
            }
            await identityActivity(tx, { kind: "installation", id: installationHash }, now)
            return "accepted" as const
          })
        } catch (error) {
          if (error instanceof NewIdentityCapped) return "new_identity_capped"
          throw error
        }
      })
    },
    async read(principal: FreePrincipal): Promise<Pick<DesktopFreeAccessStatus, "state" | "code" | "allowance">> {
      if (!owns(principal)) return { state: "unavailable", code: "free_principal_rejected", allowance: null }
      return capacity.run(() => database.transaction(async (tx) => {
        if (!await memberFreePrincipalAllowed(principal, tx)) return { state: "unavailable", code: "free_principal_rejected", allowance: null }
        const { allowance, code } = await check(tx, principal, new Date())
        if (code === "anonymous_limit_exceeded") return { state: "exhausted", code, allowance }
        if (code) return { state: "unavailable", code, allowance }
        return { state: "ready", code: null, allowance }
      }))
    },
    /** Before a request: the same "used is below the limit" check as paid Models' ensureUsableBuckets. */
    async admit(principal: FreePrincipal): Promise<FreeAdmission> {
      if (!owns(principal)) return { ok: false, code: "free_principal_rejected" }
      return capacity.run(() => database.transaction(async (tx) => {
        if (!await memberFreePrincipalAllowed(principal, tx)) return { ok: false, code: "free_principal_rejected" }
        const result = await check(tx, principal, new Date())
        return result.code ? { ok: false, code: result.code } : { ok: true, windows: result.windows }
      }))
    },
    /**
     * After a request: record its cost once and add it to each window it was admitted under. Without a usage
     * report (the stream broke, or the client left) the fixed estimate is charged instead. Returns false when this
     * request or completion was already charged.
     */
    async charge(input: { requestId: string; principal: FreePrincipal; windows: FreeWindow[]; receipt: FreeUsageReceipt | null }) {
      const receipt = validFreeReceipt(input.receipt) ? input.receipt : null
      const amount = receipt?.amount ?? config.unreportedUsageAmount
      const { principal } = input
      return database.transaction(async (tx) => {
        const usage = family === "member" ? MemberUsage : GuestUsage
        const [existing] = await tx.select({ id: usage.request_id }).from(usage).where(or(eq(usage.request_id, input.requestId),
          receipt ? eq(usage.completion_id, receipt.eventId) : undefined)).limit(1)
        if (existing) return false
        const row = { request_id: input.requestId, completion_id: receipt?.eventId ?? null, principal_hash: freePrincipalHash(principal),
          model_id: INFERENCE_FREE_MODEL_ID, amount, input_tokens: receipt?.inputTokens ?? null, output_tokens: receipt?.outputTokens ?? null, estimated: !receipt }
        try {
          if (principal.kind === "member") await tx.insert(MemberUsage).values({ ...row, organization_id: principal.organizationId,
            org_membership_id: principal.memberId, inference_key_id: principal.inferenceKeyId })
          else await tx.insert(GuestUsage).values(row)
        } catch (error) {
          if (isDuplicate(error)) return false
          throw error
        }
        for (const window of input.windows) await addUsage(tx, window, amount)
        return true
      })
    },
  }
}
export type FreeAllowanceStore = ReturnType<typeof createFreeAllowanceStore>
