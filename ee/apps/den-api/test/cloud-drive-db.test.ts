import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { once } from "node:events"
import { after, before, test } from "node:test"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { CloudDriveFileTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

const databaseUrl = process.env.DEN_DRIVE_TEST_DATABASE_URL
if (!databaseUrl) throw new Error("Set DEN_DRIVE_TEST_DATABASE_URL to a disposable loopback database ending in _drive_test.")
const url = new URL(databaseUrl)
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/[a-z0-9_]+_drive_test$/.test(url.pathname)) throw new Error("Refusing a non-disposable Drive test database.")
const objects = new Map<string, Buffer>()
let failPut = false
let failDelete = false
let puts = 0
const provider = createServer(async (req, res) => {
  assert.match(req.headers.authorization ?? "", /^AWS4-HMAC-SHA256 /)
  const key = new URL(req.url ?? "/", "http://localhost").pathname
  if (req.method === "PUT") {
    puts++
    const chunks: Uint8Array[] = []
    for await (const chunk of req) chunks.push(Uint8Array.from(chunk))
    objects.set(key, Buffer.concat(chunks))
    if (failPut) { res.writeHead(503); res.end("provider reply lost"); return }
    res.setHeader("ETag", '"synthetic-etag"'); res.end()
  } else if (req.method === "GET") {
    const bytes = objects.get(key)
    if (!bytes) { res.writeHead(404); res.end(); return }
    res.setHeader("Content-Length", bytes.length); res.end(bytes)
  } else if (req.method === "DELETE") {
    if (failDelete) { res.writeHead(503); res.end("delete failed"); return }
    objects.delete(key); res.writeHead(204); res.end()
  } else { res.writeHead(405); res.end() }
})
provider.listen(0, "127.0.0.1")
await once(provider, "listening")
const address = provider.address()
if (!address || typeof address === "string") throw new Error("Missing fixture port")
Object.assign(process.env, {
  DATABASE_URL: databaseUrl, DB_MODE: "mysql", DEN_DB_ENCRYPTION_KEY: "synthetic-drive-test-encryption-key-123456", BETTER_AUTH_SECRET: "synthetic-drive-test-auth-secret-123456789",
  BETTER_AUTH_URL: "http://127.0.0.1:8790", DEN_DRIVE_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
  DEN_DRIVE_S3_BUCKET: "drive-test", DEN_DRIVE_S3_REGION: "test", DEN_DRIVE_S3_ACCESS_KEY_ID: "synthetic-key",
  DEN_DRIVE_S3_SECRET_ACCESS_KEY: "synthetic-secret", DEN_DRIVE_S3_FORCE_PATH_STYLE: "true", DEN_DRIVE_QUOTA_BYTES: "10",
})
const { db, client } = await import("../src/db.js")
const drive = await import("../src/cloud-drive.js")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const otherMemberId = createDenTypeId("member")
const otherUserId = createDenTypeId("user")
const caller = { organizationId, memberId, userId }
const other = { organizationId, memberId: otherMemberId, userId: otherUserId }

before(async () => {
  // This fixture deliberately creates only the tables exercised by Drive.
  await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS organization (id varchar(64) PRIMARY KEY, name varchar(255) NOT NULL, slug varchar(255) NOT NULL, logo varchar(2048), allowed_email_domains json, desktop_app_restrictions json NOT NULL, metadata json, created_at timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at timestamp(3) DEFAULT CURRENT_TIMESTAMP(3))"))
  await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS member (id varchar(64) PRIMARY KEY, organization_id varchar(64) NOT NULL, user_id varchar(64), invite_id varchar(64), invited_by_org_member varchar(64), role varchar(255) DEFAULT 'member', joined_at timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), removed_at timestamp(3) NULL, removed_by_org_member varchar(64), is_setup_agent boolean DEFAULT false, created_at timestamp(3) DEFAULT CURRENT_TIMESTAMP(3))"))
  const migration = await readFile(new URL("../../../packages/den-db/drizzle/0118_cloud_drive.sql", import.meta.url), "utf8")
  try { await db.select().from(CloudDriveFileTable).limit(0) } catch {
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement))
  }
  await db.insert(OrganizationTable).values({ id: organizationId, name: "Drive test", slug: randomUUID(), metadata: { capabilities: { cloudDrive: true } }, desktopAppRestrictions: {} })
  await db.insert(MemberTable).values([{ id: memberId, organizationId, userId, role: "owner" }, { id: otherMemberId, organizationId, userId: otherUserId, role: "member" }])
})

test("concurrent uploads share a locked quota, retries do not write twice, and other members cannot read or delete", async () => {
  const ids = [randomUUID(), randomUUID()]
  const outcomes = await Promise.allSettled(ids.map((id) => drive.uploadDrive(caller, { id, path: `${id}.txt`, bytes: Buffer.from("abcdef") })))
  assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1)
  assert.equal(puts, 1)
  const listing = await drive.listDrive(caller)
  assert.equal(listing.usedBytes, 6)
  assert.equal(listing.reservedBytes, 0)
  const file = listing.items[0]
  assert.ok(file)
  const content = await drive.readDrive(caller, file.id)
  assert.equal(Buffer.from(content.contentBase64, "base64").toString(), "abcdef")
  await drive.uploadDrive(caller, { id: file.id, path: file.path, bytes: Buffer.from("abcdef") })
  assert.equal(puts, 1)
  assert.deepEqual((await drive.listDrive(other)).items, [])
  await assert.rejects(drive.readDrive(other, file.id), /File not found/)
  await assert.rejects(drive.deleteDrive(other, file.id), /File not found/)
  failDelete = true
  await assert.rejects(drive.deleteDrive(caller, file.id))
  assert.equal((await drive.listDrive(caller)).reservedBytes, 6)
  failDelete = false
  await drive.deleteDrive(caller, file.id)
  assert.equal((await drive.listDrive(caller)).reservedBytes, 0)
  assert.deepEqual((await drive.listDrive(caller)).items, [])
  await assert.rejects(drive.uploadDrive(caller, { id: file.id, path: file.path, bytes: Buffer.from("abcdef") }), /fresh UUID/)
  await drive.deleteDrive(caller, file.id)
})

test("uncertain provider writes retain space and revoked membership or organization access immediately fails closed", async () => {
  failPut = true
  const id = randomUUID()
  await assert.rejects(drive.uploadDrive(caller, { id, path: "uncertain.txt", bytes: Buffer.from("abcdef") }), /space remains reserved/)
  assert.equal((await drive.listDrive(caller)).reservedBytes, 6)
  assert.equal(objects.size, 1)
  await assert.rejects(drive.uploadDrive(caller, { id: randomUUID(), path: "overflow.txt", bytes: Buffer.from("abcdef") }), /limit is reached/)
  await db.update(OrganizationTable).set({ metadata: { capabilities: { cloudDrive: false } } }).where(eq(OrganizationTable.id, organizationId))
  await assert.rejects(drive.listDrive(caller), /unavailable/)
  await db.update(OrganizationTable).set({ metadata: { capabilities: { cloudDrive: true }, cloudDrivePolicy: { default: { quotaBytes: 10, allowedFolders: ["reports/**"] }, members: {} } } }).where(eq(OrganizationTable.id, organizationId))
  await assert.rejects(drive.uploadDrive(caller, { id: randomUUID(), path: "private/file.txt", bytes: Buffer.from("a") }), /outside your Drive access/)
  await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, memberId))
  await assert.rejects(drive.listDrive(caller), /unavailable/)
})

after(async () => {
  await db.delete(CloudDriveFileTable).where(eq(CloudDriveFileTable.organizationId, organizationId))
  await db.delete(MemberTable).where(and(eq(MemberTable.organizationId, organizationId)))
  await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
  if ("end" in client) await client.end()
  provider.closeAllConnections()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
})
