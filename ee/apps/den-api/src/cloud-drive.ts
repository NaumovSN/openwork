import { createHash } from "node:crypto"
import { and, eq, isNull, inArray } from "@openwork-ee/den-db/drizzle"
import { CloudDriveFileTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { env } from "./env.js"
import { cloudDriveEnabled, driveMemberPolicy, drivePathAllowed, DRIVE_MAX_FILE_BYTES } from "./cloud-drive-config.js"
import { createDriveStorage } from "./cloud-drive-storage.js"

type MemberId = typeof MemberTable.$inferSelect.id
type OrganizationId = typeof OrganizationTable.$inferSelect.id
export type DriveCaller = { organizationId: OrganizationId; memberId: MemberId; userId: NonNullable<typeof MemberTable.$inferSelect.userId> }
type FileRow = typeof CloudDriveFileTable.$inferSelect
let storage: ReturnType<typeof createDriveStorage> | undefined
function driveStorage() {
  if (!env.driveStorage) throw new DriveError(404, "Cloud Drive is unavailable.")
  return storage ??= createDriveStorage(env.driveStorage)
}
export class DriveError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 503, message: string) { super(message) }
}
const ownerScope = (caller: DriveCaller) => and(eq(CloudDriveFileTable.organizationId, caller.organizationId), eq(CloudDriveFileTable.memberId, caller.memberId))
const hash = (value: string | Buffer) => createHash("sha256").update(typeof value === "string" ? value : Uint8Array.from(value)).digest("hex")

/** Consult live membership and rollout, rather than relying on the auth cache. */
export async function authorizeDrive(caller: DriveCaller) {
  const [row] = await db.select({ metadata: OrganizationTable.metadata, role: MemberTable.role })
    .from(MemberTable).innerJoin(OrganizationTable, eq(MemberTable.organizationId, OrganizationTable.id))
    .where(and(eq(MemberTable.id, caller.memberId), eq(MemberTable.organizationId, caller.organizationId),
      eq(MemberTable.userId, caller.userId), isNull(MemberTable.removedAt))).limit(1)
  if (!row || !cloudDriveEnabled(row.metadata, env.driveStorage !== null)) throw new DriveError(404, "Cloud Drive is unavailable.")
  return { ...row, policy: driveMemberPolicy(row.metadata, caller.memberId, env.driveStorage?.quotaBytes ?? 0) }
}

function serializeFile(row: FileRow) {
  return { id: row.id, path: row.path, sizeBytes: row.sizeBytes, status: row.status, createdAt: row.createdAt.toISOString() }
}
export async function listDrive(caller: DriveCaller) {
  const { policy } = await authorizeDrive(caller)
  const rows = await db.select().from(CloudDriveFileTable).where(and(ownerScope(caller), inArray(CloudDriveFileTable.status, ["uploading", "ready", "deleting"])))
  return {
    items: rows.filter((row) => row.status !== "deleted" && drivePathAllowed(row.path, policy)).map(serializeFile),
    usedBytes: rows.filter((row) => row.status === "ready").reduce((total, row) => total + row.sizeBytes, 0),
    reservedBytes: rows.filter((row) => row.status !== "ready").reduce((total, row) => total + row.sizeBytes, 0),
    quotaBytes: policy.quotaBytes, maxFileBytes: DRIVE_MAX_FILE_BYTES, allowedFolders: policy.allowedFolders,
  }
}

export async function uploadDrive(caller: DriveCaller, input: { id: string; path: string; bytes: Buffer }) {
  if (input.bytes.length > DRIVE_MAX_FILE_BYTES) throw new DriveError(413, "Files must be 8 MiB or smaller.")
  const provider = driveStorage()
  const digest = hash(input.bytes)
  const row = await db.transaction(async (tx) => {
    // Serializes all reservations for this member across every Den instance.
    const [member] = await tx.select().from(MemberTable).where(and(eq(MemberTable.id, caller.memberId),
      eq(MemberTable.organizationId, caller.organizationId), eq(MemberTable.userId, caller.userId), isNull(MemberTable.removedAt))).for("update")
    const [organization] = await tx.select().from(OrganizationTable).where(eq(OrganizationTable.id, caller.organizationId))
    if (!member || !organization || !cloudDriveEnabled(organization.metadata, env.driveStorage !== null)) throw new DriveError(404, "Cloud Drive is unavailable.")
    const policy = driveMemberPolicy(organization.metadata, caller.memberId, env.driveStorage?.quotaBytes ?? 0)
    if (!drivePathAllowed(input.path, policy)) throw new DriveError(403, "This folder is outside your Drive access.")
    const rows = await tx.select().from(CloudDriveFileTable).where(and(ownerScope(caller), inArray(CloudDriveFileTable.status, ["uploading", "ready", "deleting"])))
    const [existing] = await tx.select().from(CloudDriveFileTable).where(and(ownerScope(caller), eq(CloudDriveFileTable.id, input.id))).limit(1)
    if (existing) {
      if (existing.status === "deleted") throw new DriveError(409, "Upload id has already been used. Use a fresh UUID.")
      if (existing.path !== input.path || existing.sha256 !== digest || existing.storageIdentity !== provider.identity) throw new DriveError(409, "Upload id already belongs to another file.")
      if (existing.status !== "ready") throw new DriveError(409, "This upload is unfinished. Its space remains reserved; contact your administrator.")
      return existing
    }
    if (rows.filter((entry) => entry.status !== "deleted").length >= 1000) throw new DriveError(409, "Your Drive file limit is reached (1,000 files).")
    if (rows.some((entry) => entry.pathHash === hash(input.path))) throw new DriveError(409, "A file already exists at this path.")
    if (rows.reduce((total, entry) => total + entry.sizeBytes, 0) + input.bytes.length > policy.quotaBytes) throw new DriveError(409, "Your Drive storage limit is reached.")
    const pending: typeof CloudDriveFileTable.$inferInsert = {
      id: input.id, organizationId: caller.organizationId, memberId: caller.memberId,
      path: input.path, pathHash: hash(input.path), sha256: digest, sizeBytes: input.bytes.length,
      storageIdentity: provider.identity, objectKey: `${env.driveStorage?.prefix}/${caller.organizationId}/${caller.memberId}/${input.id}`,
      status: "uploading", createdAt: new Date(),
    }
    await tx.insert(CloudDriveFileTable).values(pending)
    return null
  })
  if (row) return serializeFile(row)
  const [pending] = await db.select().from(CloudDriveFileTable).where(and(ownerScope(caller), eq(CloudDriveFileTable.id, input.id))).limit(1)
  if (!pending) throw new DriveError(409, "Upload reservation is missing.")
  try {
    await provider.put(pending.objectKey, input.bytes)
    // A removed member or disabled org cannot publish an upload after revocation.
    await authorizeDrive(caller)
    await db.update(CloudDriveFileTable).set({ status: "ready" }).where(and(ownerScope(caller), eq(CloudDriveFileTable.id, input.id), eq(CloudDriveFileTable.status, "uploading")))
    return serializeFile({ ...pending, status: "ready" })
  } catch {
    // The provider may have accepted the bytes even when its reply was lost.
    // Retain the reservation and private object key; never free unknown usage.
    throw new DriveError(503, "Upload could not finish. Its space remains reserved; contact your administrator.")
  }
}

async function ownedFile(caller: DriveCaller, id: string, allowDeleting = false) {
  const { policy } = await authorizeDrive(caller)
  const [row] = await db.select().from(CloudDriveFileTable).where(and(ownerScope(caller), eq(CloudDriveFileTable.id, id))).limit(1)
  if (!row || (!allowDeleting && row.status === "deleted") || !drivePathAllowed(row.path, policy)) throw new DriveError(404, "File not found.")
  if (row.storageIdentity !== driveStorage().identity) throw new DriveError(409, "Drive storage changed. Ask your administrator to restore its original configuration.")
  if (row.status !== "ready" && !(allowDeleting && (row.status === "deleting" || row.status === "deleted"))) throw new DriveError(409, "This file is not ready.")
  return row
}

export async function readDrive(caller: DriveCaller, id: string) {
  const row = await ownedFile(caller, id)
  const body = await driveStorage().get(row.objectKey)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) throw new DriveError(503, "Invalid stored file body.")
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > DRIVE_MAX_FILE_BYTES || size > row.sizeBytes) {
      body.destroy()
      throw new DriveError(503, "Stored file exceeds its recorded size.")
    }
    chunks.push(bytes)
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Uint8Array.from(chunk)))
  if (size !== row.sizeBytes || hash(bytes) !== row.sha256) throw new DriveError(503, "Stored file failed its integrity check.")
  await authorizeDrive(caller)
  return { ...serializeFile(row), contentBase64: bytes.toString("base64") }
}

export async function deleteDrive(caller: DriveCaller, id: string) {
  const row = await ownedFile(caller, id, true)
  if (row.status === "deleted") return { ok: true }
  // Block new reads before remote deletion; failed deletes retain their quota.
  await db.update(CloudDriveFileTable).set({ status: "deleting" }).where(and(ownerScope(caller), eq(CloudDriveFileTable.id, id)))
  await driveStorage().delete(row.objectKey)
  // Retain the id as a tombstone: a delayed concurrent delete must never
  // target a future upload that reused this object key. Release only after S3 ack.
  await db.update(CloudDriveFileTable).set({ status: "deleted", sizeBytes: 0, pathHash: `deleted-${id}` }).where(and(ownerScope(caller), eq(CloudDriveFileTable.id, id)))
  return { ok: true }
}
