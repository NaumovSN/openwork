import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderCredentialTable, GatewayProviderTable, MemberTable } from "@openwork-ee/den-db"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { parseGatewayProviderSecret, type GatewayOauthTokenSecret } from "@openwork/types/den/gateway"
import { loadGatewayAccess, sameGatewaySelection, selectGatewayGrant } from "../provider-access.js"
import type { GatewayCredentialLookup } from "../provider-credentials.js"

export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const REFRESH_WINDOW_MS = 60_000
export const GOOGLE_OAUTH_MAX_EXPIRES_IN_SECONDS = 86_400
const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const LOCK_MS = 30_000
const TOKEN_REQUEST_TIMEOUT_MS = 15_000

type CredentialRow = typeof GatewayProviderCredentialTable.$inferSelect
type CredentialSnapshot = Pick<CredentialRow, "id" | "secret" | "expires_at" | "status"> & Partial<Pick<CredentialRow, "last_error">> & { kind: "oauth_google" | "oauth_azure" }
export type OauthCredentialRow = CredentialSnapshot & Pick<CredentialRow,
  "gateway_provider_id" | "credential_set_id" | "organization_id" | "subject" | "org_membership_id" | "updated_at" | "last_refreshed_at" | "refreshing_until"> & { secret_revision: string }
export type OauthClient = { id: string; oauth_client_id: string | null; oauth_client_secret: string | null }
export type RefreshScope = { credentialId: CredentialRow["id"]; provider: OauthClient; subject: string; authorization: GatewayCredentialLookup }
export type RefreshLock = { scope: RefreshScope; credential: OauthCredentialRow }

export type GoogleOauthRefreshStore = {
  tryAcquireRefreshLock(input: { scope: RefreshScope; credential: OauthCredentialRow; now: Date; until: Date }): Promise<RefreshLock | null>
  reloadCredential(scope: RefreshScope): Promise<OauthCredentialRow | null>
  saveRefreshedToken(input: { lock: RefreshLock; secret: string; expiresAt: Date; now: Date }): Promise<boolean>
  recordRefreshFailure(input: { lock: RefreshLock; error: string | null; permanent: boolean; now: Date }): Promise<boolean>
}

export type GoogleOauthRefreshOutcome =
  | { kind: "refreshed"; credential: OauthCredentialRow }
  | { kind: "auth_required" }
  | { kind: "configuration_required" }
  | { kind: "retry"; reason: "refresh_busy" | "refresh_unavailable" | "credential_changed" }

export type RefreshGoogleOauthToken = (input: {
  credential: CredentialSnapshot
  token: GatewayOauthTokenSecret
  provider: OauthClient
  authorization: GatewayCredentialLookup
  subject: string
  now: Date
  clock?: () => Date
}) => Promise<GoogleOauthRefreshOutcome>

function isGoogleOauthTokenMaterial(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && /^[\x21-\x7e]+$/.test(value)
}

export function needsGoogleOauthRefresh(credential: { expires_at: Date | null }, token: GatewayOauthTokenSecret, now: Date) {
  return credential.expires_at !== null && Boolean(token.refreshToken)
    && credential.expires_at.getTime() - now.getTime() <= REFRESH_WINDOW_MS
}

// Secret comparison happens on decrypted values: the encrypted column uses
// randomized ciphertext and cannot be compared with eq(). Writes compare its hash.
export function sameOauthVersion(a: OauthCredentialRow, b: OauthCredentialRow) {
  return a.id === b.id && a.gateway_provider_id === b.gateway_provider_id && a.credential_set_id === b.credential_set_id
    && a.organization_id === b.organization_id && a.subject === b.subject
    && a.org_membership_id === b.org_membership_id && a.kind === b.kind
    && a.status === "active" && b.status === "active" && a.secret === b.secret
    && (a.last_error ?? null) === (b.last_error ?? null)
    && a.secret_revision === b.secret_revision
    && a.updated_at.getTime() === b.updated_at.getTime()
    && a.last_refreshed_at?.getTime() === b.last_refreshed_at?.getTime()
    && a.expires_at?.getTime() === b.expires_at?.getTime()
    && a.refreshing_until?.getTime() === b.refreshing_until?.getTime()
}

function canReuseGoogleOauthToken(credential: OauthCredentialRow, now: Date) {
  const expiresAt = credential.expires_at?.getTime() ?? NaN
  const refreshedAt = credential.last_refreshed_at?.getTime() ?? NaN
  const usableLifetime = expiresAt - refreshedAt
  const refreshWindow = refreshedAt <= now.getTime() && usableLifetime > 0
    ? Math.min(REFRESH_WINDOW_MS, usableLifetime / 2) : REFRESH_WINDOW_MS
  return Number.isFinite(expiresAt) && expiresAt - now.getTime() > refreshWindow
}

export function createGoogleOauthRefresher(deps: {
  /** Explicit transport injection is for offline tests; production should omit it. */
  tokenFetch?: typeof fetch
  store: GoogleOauthRefreshStore
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  waitMs?: number
}): RefreshGoogleOauthToken {
  const fetchToken = deps.tokenFetch ?? createInferenceEgressFetch({ allowedOrigins: new Set() })
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = Math.max(1, deps.pollMs ?? 250)
  const attempts = Math.ceil((deps.waitMs ?? 5_000) / pollMs)

  const refresh: RefreshGoogleOauthToken = async (input) => {
    const started = performance.now()
    const clock = input.clock ?? (() => new Date(input.now.getTime() + Math.floor(performance.now() - started)))
    const scope = { credentialId: input.credential.id, provider: input.provider, subject: input.subject, authorization: input.authorization }
    const row = await deps.store.reloadCredential(scope)
    if (!row || row.status !== "active") return { kind: "auth_required" }
    if (row.kind === "oauth_google" && row.last_error === "invalid_client") return { kind: "configuration_required" }
    if (!row.expires_at || !Number.isFinite(row.expires_at.getTime())) return { kind: "auth_required" }
    if (canReuseGoogleOauthToken(row, clock())) return { kind: "refreshed", credential: row }
    const latest = async (reason: "refresh_busy" | "refresh_unavailable" | "credential_changed"): Promise<GoogleOauthRefreshOutcome> => {
      const winner = await deps.store.reloadCredential(scope)
      if (!winner || winner.status !== "active") return { kind: "auth_required" }
      if (winner.kind === "oauth_google" && winner.last_error === "invalid_client") return { kind: "configuration_required" }
      if (!winner.expires_at || !Number.isFinite(winner.expires_at.getTime())) return { kind: "auth_required" }
      const now = clock()
      const refreshed = winner.secret_revision !== row.secret_revision && winner.last_error == null
        && winner.refreshing_until === null && winner.last_refreshed_at !== null
        && Number.isFinite(winner.last_refreshed_at.getTime()) && winner.last_refreshed_at <= now
      if (canReuseGoogleOauthToken(winner, now) || (refreshed && winner.expires_at > now)) return { kind: "refreshed", credential: winner }
      return { kind: "retry", reason }
    }
    // A delayed caller must not refresh a replacement using its old client.
    if (row.secret !== input.credential.secret) return { kind: "retry", reason: "credential_changed" }
    if (!input.provider.oauth_client_id || !input.provider.oauth_client_secret) return { kind: "configuration_required" }
    const acquiredAt = clock()
    const lock = await deps.store.tryAcquireRefreshLock({ scope, credential: row, now: acquiredAt, until: new Date(acquiredAt.getTime() + LOCK_MS) })
    if (!lock) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const outcome = await latest("refresh_busy")
        if (outcome.kind !== "retry") return outcome
        await sleep(pollMs)
      }
      return latest("refresh_busy")
    }

    // Acquisition and HTTP are separate; re-read after acquisition and evaluate
    // expiry again. Never send the caller's potentially obsolete refresh token.
    const current = await deps.store.reloadCredential(scope)
    if (!current || !sameOauthVersion(current, lock.credential)) return latest("credential_changed")
    let token: GatewayOauthTokenSecret
    let googleIdentity: unknown
    try {
      const parsed = parseGatewayProviderSecret(current.kind, current.secret)
      if (parsed.kind !== "oauth_google") throw new Error("Unsupported credential")
      token = parsed.token
      if (token.refreshToken !== undefined && !isGoogleOauthTokenMaterial(token.refreshToken)) throw new Error("Invalid refresh token")
      const stored: unknown = JSON.parse(current.secret)
      if (typeof stored === "object" && stored !== null && "googleIdentity" in stored) googleIdentity = stored.googleIdentity
    } catch {
      await deps.store.recordRefreshFailure({ lock, error: "invalid_token_secret", permanent: true, now: clock() })
      return latest("credential_changed")
    }
    if (!needsGoogleOauthRefresh(current, token, clock())) {
      await deps.store.recordRefreshFailure({ lock, error: null, permanent: false, now: clock() })
      return latest("credential_changed")
    }
    const requestedAt = clock()
    if (!current.refreshing_until || current.refreshing_until <= requestedAt) return latest("refresh_busy")
    let response: Response
    let body: unknown
    try {
      response = await fetchToken(GOOGLE_OAUTH_TOKEN_URL, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken!, client_id: input.provider.oauth_client_id, client_secret: input.provider.oauth_client_secret }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      })
      body = await response.json()
    } catch {
      await deps.store.recordRefreshFailure({ lock, error: "token_endpoint_unavailable", permanent: false, now: clock() })
      return latest("refresh_unavailable")
    }
    const record: Record<string, unknown> = typeof body === "object" && body !== null ? { ...body } : {}
    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500
      const invalidClient = !transient && record.error === "invalid_client"
      const permanent = !transient && record.error === "invalid_grant"
      const error = invalidClient ? "invalid_client" : permanent
        ? record.error_subtype === "invalid_rapt" ? "invalid_rapt" : "invalid_grant"
        : "token_endpoint_unavailable"
      await deps.store.recordRefreshFailure({ lock, error, permanent, now: clock() })
      return latest("refresh_unavailable")
    }
    if (!isGoogleOauthTokenMaterial(record.access_token) || !/^[A-Za-z0-9._~+\/-]+=*$/.test(record.access_token)
      || typeof record.token_type !== "string" || record.token_type.toLowerCase() !== "bearer"
      || typeof record.expires_in !== "number" || !Number.isInteger(record.expires_in) || record.expires_in <= 0 || record.expires_in > GOOGLE_OAUTH_MAX_EXPIRES_IN_SECONDS
      || (record.scope !== undefined && (typeof record.scope !== "string" || !record.scope.split(/\s+/).includes(GOOGLE_CLOUD_PLATFORM_SCOPE)))
      || (record.refresh_token !== undefined && !isGoogleOauthTokenMaterial(record.refresh_token))) {
      await deps.store.recordRefreshFailure({ lock, error: "invalid_token_response", permanent: false, now: clock() })
      return latest("refresh_unavailable")
    }
    const secret = {
      accessToken: record.access_token,
      refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : token.refreshToken,
      tokenType: "Bearer",
      ...(googleIdentity === undefined ? {} : { googleIdentity }),
    }
    const expiresAt = new Date(requestedAt.getTime() + record.expires_in * 1000)
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= clock()) {
      await deps.store.recordRefreshFailure({ lock, error: "invalid_token_expiry", permanent: false, now: clock() })
      return latest("refresh_unavailable")
    }
    await deps.store.saveRefreshedToken({ lock, secret: JSON.stringify(secret), expiresAt, now: clock() })
    return latest("credential_changed")
  }
  // Database contention/outages are retryable too; never expose a driver error
  // (which may contain SQL parameters) or turn infrastructure failure into reauth.
  return (input) => refresh(input).catch((): GoogleOauthRefreshOutcome => ({ kind: "retry", reason: "refresh_unavailable" }))
}

type Db = Pick<typeof import("../db.js").db, "select" | "update">

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

// No row locks anywhere in this store. Authorization is re-checked with plain reads
// at each step, and every credential write is a compare-and-set against the exact
// version that was read (updated_at, refreshing_until, active status and the stored
// ciphertext hash). A concurrent refresh, Den revocation, re-authorization or token
// replacement changes one of those, so the stale write matches no row. A Den access
// change that lands between the check and the write is caught by the per-request
// access check on the next call.
export function createDbGoogleOauthRefreshStore(db: Db): GoogleOauthRefreshStore {
  const table = GatewayProviderCredentialTable
  const where = (scope: RefreshScope) => and(eq(table.id, scope.credentialId),
    eq(table.gateway_provider_id, scope.authorization.scope.gatewayProviderId),
    eq(table.credential_set_id, scope.authorization.selection.row.credentialSet.id),
    eq(table.subject, scope.subject), eq(table.org_membership_id, scope.authorization.scope.orgMembershipId), eq(table.kind, "oauth_google"))

  async function currentRow(scope: RefreshScope): Promise<OauthCredentialRow | null> {
    const authorization = scope.authorization
    if (scope.subject !== authorization.scope.orgMembershipId || scope.subject !== authorization.subject) return null
    const [member] = await db.select().from(MemberTable).where(eq(MemberTable.id, authorization.scope.orgMembershipId))
    if (!member || member.removedAt || !member.userId) return null
    const [provider] = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, authorization.scope.gatewayProviderId))
    if (!provider || provider.status !== "active"
      || provider.organization_id !== member.organizationId
      || !["google-vertex", "google-vertex-anthropic"].includes(provider.provider_id)) return null
    const access = selectGatewayGrant(await loadGatewayAccess(authorization.scope, db), authorization.selection.requestedModel, authorization.selection.row.grant.id)
    if (access.kind !== "selected" || !sameGatewaySelection(authorization.selection, access.selection)) return null
    const set = access.selection.row.credentialSet
    if (set.credential_mode !== "member" || set.id !== scope.provider.id
      || set.oauth_client_id !== scope.provider.oauth_client_id || set.oauth_client_secret !== scope.provider.oauth_client_secret) return null
    // Hash stored ciphertext, not a re-encrypted SQL parameter. Replacing even
    // identical plaintext in the same millisecond gets a different revision.
    const [result] = await db.select({ credential: table, secret_revision: sql<string>`sha2(${table.secret}, 256)` })
      .from(table).where(where(scope))
    const row = result?.credential
    if (!row || row.kind !== "oauth_google" || row.organization_id !== provider.organization_id) return null
    return { ...row, kind: row.kind, secret_revision: result.secret_revision }
  }

  /** Write only if the row is still exactly `expected`; false when anything changed since it was read. */
  async function writeIfUnchanged(scope: RefreshScope, expected: OauthCredentialRow, values: Partial<typeof table.$inferInsert>) {
    const result = await db.update(table).set(values).where(and(where(scope),
      eq(table.status, "active"),
      eq(table.updated_at, expected.updated_at),
      expected.refreshing_until ? eq(table.refreshing_until, expected.refreshing_until) : isNull(table.refreshing_until),
      sql`sha2(${table.secret}, 256) = ${expected.secret_revision}`))
    return affectedRows(result) === 1
  }

  const nextVersion = (row: OauthCredentialRow, now: Date) => new Date(Math.max(now.getTime(), row.updated_at.getTime() + 1))
  return {
    async reloadCredential(scope) {
      return currentRow(scope)
    },
    async tryAcquireRefreshLock(input) {
      const row = await currentRow(input.scope)
      if (!row || row.last_error === "invalid_client" || !sameOauthVersion(row, input.credential)
        || (row.refreshing_until && row.refreshing_until.getTime() >= input.now.getTime())) return null
      const updated_at = nextVersion(row, input.now)
      // Two callers can pass the check above; only one compare-and-set matches.
      if (!await writeIfUnchanged(input.scope, row, { refreshing_until: input.until, updated_at })) return null
      return { scope: input.scope, credential: { ...row, refreshing_until: input.until, updated_at } }
    },
    async saveRefreshedToken(input) {
      const row = await currentRow(input.lock.scope)
      if (!row || !sameOauthVersion(row, input.lock.credential) || !row.refreshing_until || row.refreshing_until <= input.now) return false
      return writeIfUnchanged(input.lock.scope, row, { secret: input.secret, expires_at: input.expiresAt, last_refreshed_at: input.now,
        updated_at: nextVersion(row, input.now), refreshing_until: null, last_error: null })
    },
    async recordRefreshFailure(input) {
      const row = await currentRow(input.lock.scope)
      if (!row || !sameOauthVersion(row, input.lock.credential) || !row.refreshing_until || row.refreshing_until <= input.now) return false
      return writeIfUnchanged(input.lock.scope, row, { refreshing_until: null, last_error: input.error, updated_at: nextVersion(row, input.now),
        ...(input.permanent ? { status: "refresh_failed" } : {}) })
    },
  }
}
