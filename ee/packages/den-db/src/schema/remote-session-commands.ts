import { index, int, mediumtext, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"

export const RemoteSessionCommandTable = mysqlTable(
  "remote_session_command",
  {
    id: denTypeIdColumn("remoteSessionCommand", "id").notNull().primaryKey(),
    org_id: denTypeIdColumn("org", "org_id").notNull(),
    owner_member_id: denTypeIdColumn("member", "owner_member_id").notNull(),
    created_by_user_id: denTypeIdColumn("user", "created_by_user_id").notNull(),
    status: mysqlEnum("status", ["pending", "claimed", "delivered", "failed", "expired"]).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    prompt: text("prompt"),
    model_provider_id: varchar("model_provider_id", { length: 160 }),
    model_model_id: varchar("model_model_id", { length: 160 }),
    model_variant: varchar("model_variant", { length: 60 }),
    idempotency_key: varchar("idempotency_key", { length: 160 }),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    claimed_by_runner_id: varchar("claimed_by_runner_id", { length: 160 }),
    claimed_at: timestamp("claimed_at", { fsp: 3 }),
    session_id: varchar("session_id", { length: 240 }),
    workspace_id: varchar("workspace_id", { length: 240 }),
    result_summary: varchar("result_summary", { length: 4096 }),
    error_code: varchar("error_code", { length: 60 }),
    error_message: varchar("error_message", { length: 2000 }),
    // Progress of the desktop session after delivery, reported by the runner
    // that claimed the command. All nullable: older runners never report.
    session_status: mysqlEnum("session_status", ["running", "waiting", "idle", "error"]),
    session_waiting_for: mysqlEnum("session_waiting_for", ["permission", "question"]),
    session_engine: mysqlEnum("session_engine", ["v1", "v2"]),
    session_model_provider_id: varchar("session_model_provider_id", { length: 160 }),
    session_model_model_id: varchar("session_model_model_id", { length: 160 }),
    session_model_variant: varchar("session_model_variant", { length: 60 }),
    session_final_text: mediumtext("session_final_text"),
    session_error_code: varchar("session_error_code", { length: 60 }),
    session_error_message: varchar("session_error_message", { length: 2000 }),
    session_message_count: int("session_message_count"),
    session_observed_at: timestamp("session_observed_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("remote_session_command_idempotency_key").on(table.idempotency_key),
    index("remote_session_command_owner_status").on(table.org_id, table.owner_member_id, table.status),
    index("remote_session_command_status_expires").on(table.status, table.expires_at),
  ],
)
