import { bigint, index, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/** Durable upload reservations; bytes and provider credentials stay out of SQL. */
export const CloudDriveFileTable = mysqlTable("cloud_drive_file", {
  id: varchar("id", { length: 36 }).notNull().primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  memberId: denTypeIdColumn("member", "member_id").notNull(),
  path: varchar("path", { length: 500 }).notNull(),
  pathHash: varchar("path_hash", { length: 64 }).notNull(),
  storageIdentity: varchar("storage_identity", { length: 64 }).notNull(),
  objectKey: varchar("object_key", { length: 700 }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  status: mysqlEnum("status", ["uploading", "ready", "deleting", "deleted"]).notNull().default("uploading"),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  index("cloud_drive_member").on(table.organizationId, table.memberId),
  uniqueIndex("cloud_drive_member_path").on(table.organizationId, table.memberId, table.pathHash),
])
