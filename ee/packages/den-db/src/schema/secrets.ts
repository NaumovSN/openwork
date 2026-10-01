import {
  boolean,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import {
  compatJsonColumn,
  denTypeIdColumn,
  encryptedTextColumn,
} from "../columns"

export const SecretDefinitionTable = mysqlTable(
  "secret_definition",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    helpText: varchar("help_text", { length: 500 }).notNull().default(""),
    kind: mysqlEnum("kind", ["secret", "variable"]).notNull(),
    source: mysqlEnum("source", ["member", "organization"]).notNull(),
    required: boolean("required").notNull().default(false),
    revision: int("revision").notNull().default(1),
    retired: boolean("retired").notNull().default(false),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("secret_definition_org_name").on(
      table.organizationId,
      table.name,
    ),
  ],
)

export const SecretValueTable = mysqlTable(
  "secret_value",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    definitionId: varchar("definition_id", { length: 64 }).notNull(),
    // An explicit non-null key avoids MySQL's nullable unique-index semantics.
    ownerKey: varchar("owner_key", { length: 64 }).notNull(),
    encryptedValue: encryptedTextColumn("encrypted_value"),
    revision: int("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("secret_value_definition_owner").on(
      table.organizationId,
      table.definitionId,
      table.ownerKey,
    ),
  ],
)

export const SecretConnectionBindingTable = mysqlTable(
  "secret_connection_binding",
  {
    connectionId: denTypeIdColumn(
      "externalMcpConnection",
      "connection_id",
    ).primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    endpoint: varchar("endpoint", { length: 2048 }).notNull(),
    identity: varchar("identity", { length: 64 }).notNull(),
    revision: int("revision").notNull().default(1),
    headers:
      compatJsonColumn<Array<{ name: string; template: string }>>(
        "headers",
      ).notNull(),
    definitions:
      compatJsonColumn<Record<string, string>>("definitions").notNull(),
  },
)

export const SecretBindingApprovalTable = mysqlTable(
  "secret_binding_approval",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    memberId: denTypeIdColumn("member", "member_id").notNull(),
    connectionId: denTypeIdColumn(
      "externalMcpConnection",
      "connection_id",
    ).notNull(),
    revision: int("revision").notNull(),
    identity: varchar("identity", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("secret_binding_approval_member_connection").on(
      table.organizationId,
      table.memberId,
      table.connectionId,
    ),
  ],
)
