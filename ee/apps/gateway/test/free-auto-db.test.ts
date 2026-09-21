import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { z } from "zod"
import {
  createDenDb, AuthUserTable, OrganizationTable, MemberTable, InferenceFreeKeyTable,
  InferenceFreeUsageBucketTable as Bucket, InferenceFreeReservationTable as Reservation,
  InferenceFreeReservationChargeTable as Charge, InferenceFreeControlTable as Control,
  InferenceOrgUsageBucketTable, InferenceUsageLedgerEntryTable,
} from "@openwork-ee/den-db"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { freeInferenceWindow, INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { readAutoConfig, freeRequestReservation } from "../src/free-config.js"
import type { FreePrincipal } from "../src/free-principal.js"
import type { FreeUsageReceipt } from "../src/free-allowance.js"

const adminUrl = process.env.FREE_AUTO_MYSQL_TEST_URL
if (adminUrl) {
  const parsed = new URL(adminUrl)
  if (process.env.FREE_AUTO_MYSQL_TEST_ISOLATED !== "1" || parsed.protocol !== "mysql:"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname) || !["", "/", "/mysql"].includes(parsed.pathname)
    || parsed.search || parsed.hash) throw new Error("Use an explicitly isolated loopback MySQL administrative URL without a target database.")
}
const tableSchema = z.object({ name: z.string(), columns: z.record(z.string(), z.object({
  name: z.string(), type: z.string(), notNull: z.boolean(), primaryKey: z.boolean(), autoincrement: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
})), indexes: z.record(z.string(), z.object({ name: z.string(), columns: z.array(z.string()), isUnique: z.boolean() })),
  compositePrimaryKeys: z.record(z.string(), z.object({ name: z.string(), columns: z.array(z.string()) })),
  uniqueConstraints: z.record(z.string(), z.object({ name: z.string(), columns: z.array(z.string()) })),
  foreignKeys: z.record(z.string(), z.unknown()), checkConstraint: z.record(z.string(), z.unknown()),
})
const snapshotSchema = z.object({ tables: z.record(z.string(), tableSchema) })
function identifier(value: string) {
  assert.match(value, /^[a-zA-Z0-9_]+$/)
  return `\`${value}\``
}
function baselineSql(table: z.infer<typeof tableSchema>) {
  assert.deepEqual(table.foreignKeys, {})
  assert.deepEqual(table.checkConstraint, {})
  const definitions = Object.values(table.columns).map((column) => `${identifier(column.name)} ${column.type}${column.notNull ? " NOT NULL" : ""}${column.default !== undefined ? ` DEFAULT ${column.default === null ? "NULL" : String(column.default)}` : ""}${column.primaryKey ? " PRIMARY KEY" : ""}${column.autoincrement ? " AUTO_INCREMENT" : ""}`)
  for (const key of Object.values(table.compositePrimaryKeys)) definitions.push(`PRIMARY KEY (${key.columns.map(identifier).join(",")})`)
  for (const key of Object.values(table.uniqueConstraints)) definitions.push(`UNIQUE KEY ${identifier(key.name)} (${key.columns.map(identifier).join(",")})`)
  for (const index of Object.values(table.indexes)) definitions.push(`${index.isUnique ? "UNIQUE " : ""}KEY ${identifier(index.name)} (${index.columns.map(identifier).join(",")})`)
  return `CREATE TABLE ${identifier(table.name)} (${definitions.join(",")}) ENGINE=InnoDB`
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value))
  return value.map((row: unknown) => {
    assert.ok(row !== null && typeof row === "object" && !Array.isArray(row))
    return Object.fromEntries(Object.entries(row))
  })
}

test("free Auto SQL and 0108 upgrade in an owned random database", { skip: !adminUrl, timeout: 60000 }, async (t) => {
  assert.ok(adminUrl)
  const databaseName = `free_auto_test_${randomBytes(12).toString("hex")}`
  assert.match(databaseName, /^free_auto_test_[a-f0-9]{24}$/)
  const administrative = createDenDb({ mode: "mysql", databaseUrl: adminUrl })
  const admin = administrative.client
  assert.ok("end" in admin)
  let created = false
  const close: Array<() => Promise<void>> = []
  t.after(async () => {
    const closures = await Promise.allSettled(close.map((end) => end()))
    try {
      if (created) {
        await admin.query(`DROP DATABASE ${identifier(databaseName)}`)
        const [remaining] = await admin.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [databaseName])
        assert.deepEqual(records(remaining), [])
        t.diagnostic(`Dropped and verified removal of owned database ${databaseName}`)
      }
      assert.ok(closures.every((result) => result.status === "fulfilled"), "all owned application pools close")
    } finally { await admin.end() }
  })
  await admin.query(`CREATE DATABASE ${identifier(databaseName)}`)
  created = true
  const url = new URL(adminUrl)
  url.pathname = `/${databaseName}`
  process.env.DATABASE_URL = url.href
  process.env.DB_MODE = "mysql"
  process.env.OPENWORK_DEV_MODE = "1"
  process.env.GATEWAY_ENABLED = "false"
  process.env.DEN_DB_ENCRYPTION_KEY = "free-auto-sql-fixture-encryption-key-0000000000"
  process.env.BETTER_AUTH_SECRET = "free-auto-sql-fixture-auth-secret-000000000000"
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
  process.env.INFERENCE_FREE_ENABLED = "true"
  process.env.INFERENCE_FREE_WEEKLY_BUDGET_USD = "5"
  const application = createDenDb({ mode: "mysql", databaseUrl: url.href })
  const replica = createDenDb({ mode: "mysql", databaseUrl: url.href })
  const connection = application.client
  const otherConnection = replica.client
  assert.ok("end" in connection && "end" in otherConnection)
  close.push(() => connection.end(), () => otherConnection.end())
  const db = application.db
  const rows = async (statement: string, values: unknown[] = []) => records((await connection.query(statement, values))[0])
  const before = snapshotSchema.parse(JSON.parse(await readFile(new URL("../../../packages/den-db/drizzle/meta/0107_snapshot.json", import.meta.url), "utf8")))
  const after = snapshotSchema.parse(JSON.parse(await readFile(new URL("../../../packages/den-db/drizzle/meta/0108_snapshot.json", import.meta.url), "utf8")))
  const baseline = ["user", "organization", "member", "gateway_providers", "inference_keys", "inference_org_limit_policies", "inference_org_usage_buckets", "inference_usage_ledger_entries", "inference_usage_ledger_bucket_charges"]
  for (const name of baseline) await connection.query(baselineSql(before.tables[name]))
  await connection.query("INSERT INTO gateway_providers (id,organization_id,created_by_org_membership_id,provider_id,name,model_ids,provider_config,settings) VALUES ('old-provider','org-fixture','member-fixture','fixture','Existing provider',JSON_ARRAY('kept-model'),JSON_OBJECT(),JSON_OBJECT())")
  await t.test("0108 executes over 0107 table shapes and preserves old rows with empty default pins", async () => {
    const migration = await readFile(new URL("../../../packages/den-db/drizzle/0108_free_auto_and_provider_pins.sql", import.meta.url), "utf8")
    const statements = migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)
    assert.equal(statements.length, 12)
    for (const statement of statements) await connection.query(statement)
    const added = Object.keys(after.tables).filter((name) => !before.tables[name]).sort()
    assert.deepEqual(added, ["desktop_free_proof_nonces", "inference_free_control", "inference_free_keys", "inference_free_rate_buckets", "inference_free_reservation_charges", "inference_free_reservations", "inference_free_usage_buckets"])
    for (const name of added) {
      const columns = await rows("SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [name])
      assert.deepEqual(columns, Object.values(after.tables[name].columns).map((column) => ({ name: column.name, nullable: column.notNull ? "NO" : "YES" })))
      const indexes = await rows("SELECT INDEX_NAME AS name, COLUMN_NAME AS col, NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY BINARY INDEX_NAME, SEQ_IN_INDEX", [name])
      const expected = [
        ...Object.values(after.tables[name].compositePrimaryKeys).flatMap((key) => key.columns.map((col) => ({ name: "PRIMARY", col, nonUnique: 0 }))),
        ...Object.values(after.tables[name].uniqueConstraints).flatMap((key) => key.columns.map((col) => ({ name: key.name, col, nonUnique: 0 }))),
        ...Object.values(after.tables[name].indexes).flatMap((key) => key.columns.map((col) => ({ name: key.name, col, nonUnique: key.isUnique ? 0 : 1 }))),
      ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      assert.deepEqual(indexes, expected, `${name} indexes match generated 0108 snapshot`)
    }
    await connection.query("INSERT INTO gateway_providers (id,organization_id,created_by_org_membership_id,provider_id,name,provider_config,settings) VALUES ('new-provider','org-fixture','member-fixture','fixture','New provider',JSON_OBJECT(),JSON_OBJECT())")
    assert.deepEqual(await rows("SELECT id, JSON_LENGTH(pinned_model_ids) AS pins FROM gateway_providers ORDER BY id"), [{ id: "new-provider", pins: 0 }, { id: "old-provider", pins: 0 }])
    assert.deepEqual(await rows("SELECT JSON_UNQUOTE(JSON_EXTRACT(model_ids,'$[0]')) AS model FROM gateway_providers WHERE id='old-provider'"), [{ model: "kept-model" }])
    t.diagnostic(`Applied ${statements.length} generated 0108 statements; verified seven new tables, every column/index, and old/new provider pin defaults`)
  })
  const { createFreeAllowanceStore } = await import("../src/free-allowance.js")
  const { findMemberFreePrincipal, freePrincipalHash, memberFreePrincipalAllowed } = await import("../src/free-principal.js")
  const gatewayDb = await import("../src/db.js")
  if ("end" in gatewayDb.client) { const client = gatewayDb.client; close.push(() => client.end()) }
  const { ensureMemberFreeInferenceCredential, getMemberInferenceAccess } = await import("../../den-api/src/inference.js")
  const denDb = await import("../../den-api/src/db.js")
  if ("end" in denDb.client) { const client = denDb.client; close.push(() => client.end()) }
  const config = readAutoConfig({})
  assert.equal(config.memberEnabled, false)
  assert.equal(config.anonymousEnabled, false)
  const store = createFreeAllowanceStore(config, db)
  const otherStore = createFreeAllowanceStore(config, replica.db)
  const hold = freeRequestReservation(config)
  const ip = "1".repeat(64)
  const id = () => randomUUID()
  const receipt = (amount = 100000): FreeUsageReceipt => ({ eventId: id(), model: INFERENCE_FREE_MODEL_ID, amount, inputTokens: 10, outputTokens: 2 })
  async function person(userId?: typeof AuthUserTable.$inferSelect.id) {
    const organizationId = createDenTypeId("organization"), memberId = createDenTypeId("member")
    const user = userId ?? createDenTypeId("user")
    await db.insert(OrganizationTable).values({ id: organizationId, name: "Free SQL fixture", slug: randomUUID() })
    if (!userId) await db.insert(AuthUserTable).values({ id: user, name: "Fixture", email: `${user}@example.test` })
    await db.insert(MemberTable).values({ id: memberId, organizationId, userId: user, role: "member" })
    const input = { organizationId, memberId, userId: user }
    const credential = await ensureMemberFreeInferenceCredential(input)
    assert.ok(credential)
    const principal = await findMemberFreePrincipal(credential.apiKey, db)
    assert.ok(principal)
    return { input, credential, principal }
  }
  const bucket = async (principal: FreePrincipal) => {
    const [row] = await db.select().from(Bucket).where(and(eq(Bucket.scope, principal.kind), eq(Bucket.identity_hash, freePrincipalHash(principal)), eq(Bucket.window_start_at, freeInferenceWindow().start))).limit(1)
    assert.ok(row)
    return row
  }
  const reservation = async (requestId: string) => {
    const [row] = await db.select().from(Reservation).where(eq(Reservation.request_id, requestId)).limit(1)
    assert.ok(row)
    return row
  }
  const admit = async (principal: FreePrincipal, requestId = id()) => {
    const result = await store.reserve(principal, ip, requestId, Date.now() + 60000)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.ok)
    return result
  }
  const sentinelOrg = createDenTypeId("organization"), sentinelMember = createDenTypeId("member")
  await db.insert(InferenceOrgUsageBucketTable).values({ id: createDenTypeId("inferenceOrgUsageBucket"), organization_id: sentinelOrg,
    policy_id: createDenTypeId("inferenceOrgLimitPolicy"), window_start_at: new Date(), window_end_at: new Date(Date.now() + 60000), limit_amount: 1000000, used_amount: 12345 })
  await db.insert(InferenceUsageLedgerEntryTable).values({ id: createDenTypeId("inferenceUsageLedgerEntry"), organization_id: sentinelOrg,
    org_membership_id: sentinelMember, external_job_id: "paid-sentinel", event_type: "openrouter_usage", cost_amount: 12345, occurred_at: new Date() })
  const paidBefore = { buckets: await rows("SELECT * FROM inference_org_usage_buckets"), ledger: await rows("SELECT * FROM inference_usage_ledger_entries") }

  await t.test("real Den issuance serializes keys; member and device defaults are $5/$1", async () => {
    const member = await person()
    const credentials = await Promise.all(Array.from({ length: 6 }, () => ensureMemberFreeInferenceCredential(member.input)))
    assert.ok(credentials.every((value) => value?.apiKey === member.credential.apiKey))
    const stored = await rows("SELECT encrypted_key FROM inference_free_keys WHERE id=?", [member.principal.keyId])
    assert.notEqual(stored[0].encrypted_key, member.credential.apiKey)
    assert.equal((await getMemberInferenceAccess(member.input)).weeklyLimitUsd, 5)
    const guest: FreePrincipal = { kind: "installation", id: "a".repeat(64) }
    const [memberAdmission, guestAdmission] = await Promise.all([admit(member.principal), admit(guest)])
    assert.equal((await bucket(member.principal)).limit_amount, 5 * INFERENCE_USAGE_CONVERSION_FACTOR)
    assert.equal((await bucket(guest)).limit_amount, INFERENCE_USAGE_CONVERSION_FACTOR)
    assert.equal((await store.read(member.principal, ip)).allowance?.limitUsd, 5)
    assert.equal((await store.read(guest, ip)).allowance?.limitUsd, 1)
    await store.cancelUndispatched(memberAdmission.requestId)
    await store.cancelUndispatched(guestAdmission.requestId)
  })

  await t.test("two SQL pools admit one request per person across memberships while independent users progress", async () => {
    const first = await person(), same = await person(first.input.userId), independent = await person()
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? otherStore : store).reserve(index % 2 ? same.principal : first.principal, ip, id(), Date.now() + 60000)))
    const winners = attempts.filter((result) => result.ok)
    assert.equal(winners.length, 1)
    assert.ok(attempts.filter((result) => !result.ok).every((result) => result.code === "free_request_in_progress"))
    const separate = await admit(independent.principal)
    assert.equal((await bucket(first.principal)).reserved_amount, hold)
    assert.equal((await bucket(independent.principal)).reserved_amount, hold)
    assert.equal((await db.select().from(Charge).where(eq(Charge.request_id, winners[0].requestId))).length, 4)
    await store.cancelUndispatched(winners[0].requestId)
    await store.cancelUndispatched(separate.requestId)
  })

  await t.test("concurrent duplicate settlement charges once across every original bucket", async () => {
    const member = await person(), admitted = await admit(member.principal)
    assert.equal(await store.dispatch(admitted.requestId, member.principal, admitted.deadlineAt), true)
    const usage = receipt()
    const results = await Promise.all([store.settle(admitted.requestId, usage), otherStore.settle(admitted.requestId, usage)])
    assert.deepEqual(results.sort(), [false, true])
    const charges = await db.select().from(Charge).where(eq(Charge.request_id, admitted.requestId))
    assert.equal(charges.length, 4)
    const beforeReplay = await rows("SELECT * FROM inference_free_usage_buckets ORDER BY id")
    assert.equal(await store.settle(admitted.requestId, { ...usage, amount: 1 }), false)
    assert.deepEqual(await rows("SELECT * FROM inference_free_usage_buckets ORDER BY id"), beforeReplay)
    assert.equal((await bucket(member.principal)).used_amount, usage.amount)
    assert.equal((await bucket(member.principal)).reserved_amount, 0)
    assert.equal((await reservation(admitted.requestId)).status, "settled")
  })

  await t.test("retained unknown liability releases the slot and neither retries nor late receipts refund it", async () => {
    const member = await person(), admitted = await admit(member.principal)
    assert.equal(await store.dispatch(admitted.requestId, member.principal, admitted.deadlineAt), true)
    assert.equal(await store.cancelUndispatched(admitted.requestId), false)
    assert.equal(await store.settle(admitted.requestId, null), true)
    assert.equal((await reservation(admitted.requestId)).status, "retained")
    assert.equal((await bucket(member.principal)).used_amount, hold)
    assert.equal((await bucket(member.principal)).reserved_amount, 0)
    const snapshot = await rows("SELECT * FROM inference_free_usage_buckets ORDER BY id")
    assert.equal(await otherStore.settle(admitted.requestId, receipt(0)), false)
    assert.equal(await otherStore.settle(admitted.requestId, null), false)
    assert.deepEqual(await rows("SELECT * FROM inference_free_usage_buckets ORDER BY id"), snapshot)
    const next = await admit(member.principal)
    await store.cancelUndispatched(next.requestId)
    assert.equal((await bucket(member.principal)).used_amount, hold)
  })

  await t.test("an expired orphan is retained rather than refunded and no longer blocks its person", async () => {
    const member = await person(), admitted = await admit(member.principal)
    await db.update(Reservation).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(Reservation.request_id, admitted.requestId))
    assert.equal((await otherStore.read(member.principal, ip)).state, "ready")
    assert.equal((await reservation(admitted.requestId)).status, "retained")
    assert.equal((await bucket(member.principal)).used_amount, hold)
    const next = await admit(member.principal)
    await store.cancelUndispatched(next.requestId)
    assert.equal((await bucket(member.principal)).used_amount, hold)
  })

  await t.test("DPA and admin policy deny credentials and dispatch; revoked keys cannot admit but incurred usage settles", async () => {
    const member = await person(), admitted = await admit(member.principal)
    await db.update(OrganizationTable).set({ metadata: { dpaSigned: true } }).where(eq(OrganizationTable.id, member.input.organizationId))
    await assert.rejects(ensureMemberFreeInferenceCredential(member.input), { code: "managed_models_disabled_for_dpa" })
    await assert.rejects(store.dispatch(admitted.requestId, member.principal, admitted.deadlineAt), { code: "managed_models_disabled_for_dpa" })
    await assert.rejects(otherStore.reserve(member.principal, ip, id(), Date.now() + 60000), { code: "managed_models_disabled_for_dpa" })
    assert.equal((await reservation(admitted.requestId)).status, "held")
    assert.equal(await store.cancelUndispatched(admitted.requestId), true)
    await db.update(OrganizationTable).set({ metadata: { inferenceFree: { offerAllowed: false } } }).where(eq(OrganizationTable.id, member.input.organizationId))
    assert.equal(await ensureMemberFreeInferenceCredential(member.input), null)
    assert.equal(await findMemberFreePrincipal(member.credential.apiKey, db), null)
    await db.update(OrganizationTable).set({ metadata: {} }).where(eq(OrganizationTable.id, member.input.organizationId))
    const incurred = await admit(member.principal)
    assert.equal(await store.dispatch(incurred.requestId, member.principal, incurred.deadlineAt), true)
    await db.update(InferenceFreeKeyTable).set({ revoked_at: new Date() }).where(eq(InferenceFreeKeyTable.id, member.principal.keyId))
    assert.equal(await findMemberFreePrincipal(member.credential.apiKey, replica.db), null)
    assert.equal((await otherStore.reserve(member.principal, ip, id(), Date.now() + 60000)).ok, false)
    assert.equal(await store.settle(incurred.requestId, receipt()), true)
    assert.equal((await bucket(member.principal)).used_amount, 100000)
  })

  await t.test("membership removal and a new join epoch invalidate old keys", async () => {
    const member = await person()
    await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, member.input.memberId))
    assert.equal(await memberFreePrincipalAllowed(member.principal, replica.db), false)
    assert.equal(await ensureMemberFreeInferenceCredential(member.input), null)
    await db.update(MemberTable).set({ removedAt: null, joinedAt: new Date(Date.now() + 1000) }).where(eq(MemberTable.id, member.input.memberId))
    assert.equal(await findMemberFreePrincipal(member.credential.apiKey, db), null)
    const next = await ensureMemberFreeInferenceCredential(member.input)
    assert.ok(next)
    assert.notEqual(next.apiKey, member.credential.apiKey)
    assert.ok(await findMemberFreePrincipal(next.apiKey, replica.db))
    assert.equal(await findMemberFreePrincipal(member.credential.apiKey, replica.db), null)
  })

  await t.test("a different key for the same person cannot dispatch an existing admission", async () => {
    const member = await person(), another = await person(member.input.userId)
    const admitted = await admit(member.principal)
    assert.equal(await otherStore.dispatch(admitted.requestId, another.principal, admitted.deadlineAt), false)
    assert.equal((await reservation(admitted.requestId)).status, "held")
    assert.equal(await store.dispatch(admitted.requestId, member.principal, admitted.deadlineAt), true)
    await store.settle(admitted.requestId, receipt())
  })

  await t.test("proof nonce uniqueness survives committed transactions and competing SQL pools", async () => {
    const proof = { keyThumbprint: "b".repeat(64), nonce: id(), timestamp: Date.now(), appVersion: "1.2.3", platform: "darwin", arch: "arm64" } satisfies import("../src/desktop-free-proof.js").DesktopFreeBinding & { nonce: string; timestamp: number }
    assert.deepEqual((await Promise.all([store.consumeNonce(proof, ip), otherStore.consumeNonce(proof, ip)])).sort(), ["accepted", "replay"])
    assert.equal(await otherStore.consumeNonce(proof, ip), "replay")
    assert.equal((await rows("SELECT COUNT(*) AS amount FROM desktop_free_proof_nonces"))[0].amount, 1)
  })

  await t.test("late overrun of retained liability trips the SQL safety switch without a refund", async () => {
    const member = await person(), admitted = await admit(member.principal)
    assert.equal(await store.dispatch(admitted.requestId, member.principal, admitted.deadlineAt), true)
    await store.settle(admitted.requestId, null)
    assert.equal(await otherStore.settle(admitted.requestId, receipt(hold + 1)), false)
    const [control] = await db.select().from(Control).where(eq(Control.id, "free-auto"))
    assert.equal(control.blocked, true)
    assert.equal((await bucket(member.principal)).used_amount, hold)
    assert.equal((await store.reserve(member.principal, ip, id(), Date.now() + 60000)).ok, false)
  })

  await t.test("free migrations and all runtime cases leave seeded paid accounting unchanged", async () => {
    assert.deepEqual({ buckets: await rows("SELECT * FROM inference_org_usage_buckets"), ledger: await rows("SELECT * FROM inference_usage_ledger_entries") }, paidBefore)
    assert.equal((await db.select({ amount: sql<number>`count(*)` }).from(Reservation))[0].amount > 0, true)
  })
})
