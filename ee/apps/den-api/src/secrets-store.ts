import { randomUUID } from "node:crypto"
import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  SecretDefinitionTable,
  SecretValueTable,
  SecretConnectionBindingTable,
  SecretBindingApprovalTable,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type {
  SecretDefinitionInput,
  SecretBindingInput,
  SecretList,
  SecretValueStatus,
  SecretBindingStatus,
} from "@openwork/types/den/secrets"
import { db } from "./db.js"
import {
  getExternalMcpConnection,
  listExternalMcpConnections,
  memberCanUseExternalMcpConnection,
  listUsableExternalMcpConnections,
} from "./capability-sources/external-mcp-connections.js"
import { listTeamsForMember } from "./orgs.js"
import {
  SecretSetupError,
  templateNames,
  validateTemplateHeaders,
  secretConnectionIdentity,
  expandTemplate,
} from "./secrets-template.js"

export type SecretsActor = {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  userId: DenTypeId<"user">
  admin: boolean
}
type Definition = typeof SecretDefinitionTable.$inferSelect
type Binding = typeof SecretConnectionBindingTable.$inferSelect
const definitionWhere = (actor: SecretsActor, id: string) =>
  and(
    eq(SecretDefinitionTable.organizationId, actor.organizationId),
    eq(SecretDefinitionTable.id, id),
    eq(SecretDefinitionTable.retired, false),
  )
const valueWhere = (actor: SecretsActor, definition: Definition) =>
  and(
    eq(SecretValueTable.organizationId, actor.organizationId),
    eq(SecretValueTable.definitionId, definition.id),
    eq(
      SecretValueTable.ownerKey,
      definition.source === "organization" ? "organization" : actor.memberId,
    ),
  )
function adminOnly(actor: SecretsActor) {
  if (!actor.admin)
    throw new SecretSetupError(
      "admin_required",
      "Only a workspace admin can manage requirements and shared values.",
      403,
    )
}
export async function activeSecretMember(
  organizationId: DenTypeId<"organization">,
  memberId: DenTypeId<"member">,
) {
  const [member] = await db
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.organizationId, organizationId),
        eq(MemberTable.id, memberId),
        isNull(MemberTable.removedAt),
      ),
    )
    .limit(1)
  if (!member?.userId)
    throw new SecretSetupError(
      "access_denied",
      "Your workspace access has ended.",
      403,
    )
  return { ...member, userId: member.userId }
}
export async function usableSecretConnection(
  actor: Pick<SecretsActor, "organizationId" | "memberId">,
  connectionId: DenTypeId<"externalMcpConnection">,
) {
  await activeSecretMember(actor.organizationId, actor.memberId)
  const connection = await getExternalMcpConnection({
    organizationId: actor.organizationId,
    connectionId,
  })
  const teams = await listTeamsForMember({
    organizationId: actor.organizationId,
    memberId: actor.memberId,
  })
  if (
    !connection ||
    !(await memberCanUseExternalMcpConnection({
      connectionId,
      orgMembershipId: actor.memberId,
      teamIds: teams.map((team) => team.id),
    }))
  )
    throw new SecretSetupError(
      "connection_access_denied",
      "This connection is not available to you.",
      403,
    )
  return connection
}

export async function createSecretDefinition(
  actor: SecretsActor,
  input: SecretDefinitionInput,
) {
  adminOnly(actor)
  await activeSecretMember(actor.organizationId, actor.memberId)
  const [existing] = await db
    .select({ id: SecretDefinitionTable.id })
    .from(SecretDefinitionTable)
    .where(
      and(
        eq(SecretDefinitionTable.organizationId, actor.organizationId),
        eq(SecretDefinitionTable.name, input.name),
      ),
    )
    .limit(1)
  if (existing)
    throw new SecretSetupError(
      "name_in_use",
      "That name is already in use. Choose another name.",
    )
  const id = randomUUID()
  await db
    .insert(SecretDefinitionTable)
    .values({
      id,
      organizationId: actor.organizationId,
      ...input,
      required: input.source === "member" && input.required,
    })
  return id
}

export async function editSecretDefinition(
  actor: SecretsActor,
  id: string,
  input: {
    label: string
    helpText: string
    required: boolean
    expectedRevision: number
  },
) {
  adminOnly(actor)
  await db.transaction(async (tx) => {
    const [definition] = await tx
      .select()
      .from(SecretDefinitionTable)
      .where(definitionWhere(actor, id))
      .limit(1)
      .for("update")
    if (!definition)
      throw new SecretSetupError(
        "not_found",
        "This requirement no longer exists.",
        404,
      )
    if (definition.revision !== input.expectedRevision)
      throw new SecretSetupError(
        "stale_revision",
        "This requirement changed. Refresh before saving.",
      )
    await tx
      .update(SecretDefinitionTable)
      .set({
        label: input.label,
        helpText: input.helpText,
        required: definition.source === "member" && input.required,
        revision: definition.revision + 1,
      })
      .where(definitionWhere(actor, id))
  })
}

export async function saveSecretValue(
  actor: SecretsActor,
  id: string,
  expectedRevision: number,
  value: string | null,
) {
  await db.transaction(async (tx) => {
    // Serialize membership removal and writes before a value can be inserted.
    const [member] = await tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(
        and(
          eq(MemberTable.id, actor.memberId),
          eq(MemberTable.organizationId, actor.organizationId),
          isNull(MemberTable.removedAt),
        ),
      )
      .limit(1)
      .for("update")
    if (!member)
      throw new SecretSetupError(
        "access_denied",
        "Your workspace access has ended.",
        403,
      )
    const [definition] = await tx
      .select()
      .from(SecretDefinitionTable)
      .where(definitionWhere(actor, id))
      .limit(1)
      .for("update")
    if (!definition)
      throw new SecretSetupError(
        "not_found",
        "This requirement no longer exists.",
        404,
      )
    if (definition.source === "organization") adminOnly(actor)
    if (
      value !== null &&
      (Buffer.byteLength(value, "utf8") > 4096 ||
        (definition.kind === "secret" && !value.length))
    )
      throw new SecretSetupError(
        "invalid_value",
        "Enter a value of up to 4 KiB; use Clear to remove it.",
        400,
      )
    const [existing] = await tx
      .select({ id: SecretValueTable.id, revision: SecretValueTable.revision })
      .from(SecretValueTable)
      .where(valueWhere(actor, definition))
      .limit(1)
      .for("update")
    if ((existing?.revision ?? 0) !== expectedRevision)
      throw new SecretSetupError(
        "stale_revision",
        "This value changed. Refresh before replacing it.",
      )
    if (existing)
      await tx
        .update(SecretValueTable)
        .set({
          encryptedValue: value,
          revision: existing.revision + 1,
          updatedAt: new Date(),
        })
        .where(valueWhere(actor, definition))
    else
      await tx
        .insert(SecretValueTable)
        .values({
          id: randomUUID(),
          organizationId: actor.organizationId,
          definitionId: definition.id,
          ownerKey:
            definition.source === "organization"
              ? "organization"
              : actor.memberId,
          encryptedValue: value,
          revision: 1,
        })
  })
}

export async function listSecretDefinitions(
  actor: SecretsActor,
): Promise<SecretValueStatus[]> {
  await activeSecretMember(actor.organizationId, actor.memberId)
  const definitions = await db
    .select()
    .from(SecretDefinitionTable)
    .where(
      and(
        eq(SecretDefinitionTable.organizationId, actor.organizationId),
        eq(SecretDefinitionTable.retired, false),
        actor.admin ? undefined : eq(SecretDefinitionTable.source, "member"),
      ),
    )
  return Promise.all(
    definitions.map(async (definition) => {
      // Status reads never select the encrypted column through its decrypting adapter.
      const [status] = await db
        .select({
          revision: SecretValueTable.revision,
          saved: sql<number>`CASE WHEN ${SecretValueTable.encryptedValue} IS NULL THEN 0 ELSE 1 END`,
          updatedAt: SecretValueTable.updatedAt,
        })
        .from(SecretValueTable)
        .where(valueWhere(actor, definition))
        .limit(1)
      let variableValue: string | undefined
      if (definition.kind === "variable" && status?.saved) {
        const [readable] = await db
          .select({ value: SecretValueTable.encryptedValue })
          .from(SecretValueTable)
          .where(valueWhere(actor, definition))
          .limit(1)
        variableValue = readable?.value ?? undefined
      }
      let completionCount: number | undefined
      if (actor.admin && definition.source === "member") {
        const [count] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(SecretValueTable)
          .innerJoin(
            MemberTable,
            and(
              eq(MemberTable.id, SecretValueTable.ownerKey),
              eq(MemberTable.organizationId, actor.organizationId),
              isNull(MemberTable.removedAt),
            ),
          )
          .where(
            and(
              eq(SecretValueTable.definitionId, definition.id),
              eq(SecretValueTable.organizationId, actor.organizationId),
              sql`${SecretValueTable.encryptedValue} IS NOT NULL`,
            ),
          )
        completionCount = Number(count?.count ?? 0)
      }
      return {
        id: definition.id,
        name: definition.name,
        label: definition.label,
        helpText: definition.helpText,
        kind: definition.kind,
        source: definition.source,
        required: definition.required,
        revision: definition.revision,
        valueRevision: status?.revision ?? 0,
        saved: Boolean(status?.saved),
        updatedAt: status?.updatedAt?.toISOString() ?? null,
        ...(variableValue !== undefined ? { variableValue } : {}),
        ...(completionCount !== undefined ? { completionCount } : {}),
      }
    }),
  )
}

export async function getSecretBinding(
  organizationId: DenTypeId<"organization">,
  connectionId: DenTypeId<"externalMcpConnection">,
): Promise<Binding | undefined> {
  const [binding] = await db
    .select()
    .from(SecretConnectionBindingTable)
    .where(
      and(
        eq(SecretConnectionBindingTable.organizationId, organizationId),
        eq(SecretConnectionBindingTable.connectionId, connectionId),
      ),
    )
    .limit(1)
  return binding
}

export async function saveSecretBinding(
  actor: SecretsActor,
  connectionId: DenTypeId<"externalMcpConnection">,
  input: SecretBindingInput,
) {
  adminOnly(actor)
  await activeSecretMember(actor.organizationId, actor.memberId)
  await db.transaction(async (tx) => {
    const connection = await getExternalMcpConnection({
      organizationId: actor.organizationId,
      connectionId,
    })
    if (!connection || connection.kind !== "external_mcp")
      throw new SecretSetupError(
        "not_found",
        "Choose an external MCP connection.",
        404,
      )
    validateTemplateHeaders(input.headers, connection.authType)
    const names = [
      ...new Set(
        input.headers.flatMap((header) => templateNames(header.template)),
      ),
    ]
    const definitions = await tx
      .select()
      .from(SecretDefinitionTable)
      .where(
        and(
          eq(SecretDefinitionTable.organizationId, actor.organizationId),
          eq(SecretDefinitionTable.retired, false),
        ),
      )
    const byName = new Map(
      definitions.map((definition) => [definition.name, definition]),
    )
    const bindings: Record<string, string> = {}
    for (const name of names) {
      const definition = byName.get(name)
      if (!definition)
        throw new SecretSetupError(
          "unknown_reference",
          `Define ${name} before using it in a connection.`,
          400,
        )
      if (
        definition.source === "member" &&
        connection.credentialMode !== "per_member"
      )
        throw new SecretSetupError(
          "member_mode_required",
          "Choose per-person authentication before binding a member value.",
          400,
        )
      bindings[name] = definition.id
    }
    const [previous] = await tx
      .select()
      .from(SecretConnectionBindingTable)
      .where(
        and(
          eq(SecretConnectionBindingTable.organizationId, actor.organizationId),
          eq(SecretConnectionBindingTable.connectionId, connectionId),
        ),
      )
      .limit(1)
      .for("update")
    if ((previous?.revision ?? 0) !== input.expectedRevision)
      throw new SecretSetupError(
        "stale_revision",
        "Connection templates changed. Refresh before saving.",
      )
    const next = {
      organizationId: actor.organizationId,
      endpoint: connection.url,
      identity: secretConnectionIdentity(connection),
      revision: (previous?.revision ?? 0) + 1,
      headers: input.headers,
      definitions: bindings,
    }
    if (previous)
      await tx
        .update(SecretConnectionBindingTable)
        .set(next)
        .where(eq(SecretConnectionBindingTable.connectionId, connectionId))
    else
      await tx
        .insert(SecretConnectionBindingTable)
        .values({ connectionId, ...next })
    await tx
      .delete(SecretBindingApprovalTable)
      .where(
        and(
          eq(SecretBindingApprovalTable.organizationId, actor.organizationId),
          eq(SecretBindingApprovalTable.connectionId, connectionId),
        ),
      )
  })
}

export async function secretBindingStatus(
  actor: SecretsActor,
  connection: NonNullable<Awaited<ReturnType<typeof getExternalMcpConnection>>>,
  binding: Binding,
): Promise<SecretBindingStatus> {
  const definitions = await db
    .select()
    .from(SecretDefinitionTable)
    .where(eq(SecretDefinitionTable.organizationId, actor.organizationId))
  const byId = new Map(
    definitions.map((definition) => [definition.id, definition]),
  )
  const bound = Object.values(binding.definitions).map((id) => byId.get(id))
  const personal = bound.some((definition) => definition?.source === "member")
  const [approval] = await db
    .select({
      revision: SecretBindingApprovalTable.revision,
      identity: SecretBindingApprovalTable.identity,
    })
    .from(SecretBindingApprovalTable)
    .where(
      and(
        eq(SecretBindingApprovalTable.organizationId, actor.organizationId),
        eq(SecretBindingApprovalTable.memberId, actor.memberId),
        eq(SecretBindingApprovalTable.connectionId, connection.id),
      ),
    )
    .limit(1)
  const sameIdentity = binding.identity === secretConnectionIdentity(connection)
  const approved =
    sameIdentity &&
    (!personal ||
      (approval?.revision === binding.revision &&
        approval.identity === binding.identity))
  const missingLabels: string[] = []
  let needsAdmin = !sameIdentity
  for (const definition of bound) {
    if (!definition || definition.retired) {
      needsAdmin = true
      continue
    }
    const [status] = await db
      .select({
        saved: sql<number>`CASE WHEN ${SecretValueTable.encryptedValue} IS NULL THEN 0 ELSE 1 END`,
      })
      .from(SecretValueTable)
      .where(valueWhere(actor, definition))
      .limit(1)
    if (!status?.saved) {
      if (definition.source === "organization") needsAdmin = true
      else missingLabels.push(definition.label)
    }
  }
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    endpoint: binding.endpoint,
    revision: binding.revision,
    headers: actor.admin ? binding.headers : [],
    labels: bound.flatMap((definition) =>
      definition && (actor.admin || definition.source === "member")
        ? [definition.label]
        : [],
    ),
    approved,
    ready: approved && !needsAdmin && !missingLabels.length,
    missingLabels,
    needsAdmin,
  }
}

export async function listSecrets(actor: SecretsActor): Promise<SecretList> {
  const definitions = await listSecretDefinitions(actor)
  const teams = await listTeamsForMember({
    organizationId: actor.organizationId,
    memberId: actor.memberId,
  })
  const connections = actor.admin
    ? await listExternalMcpConnections(actor.organizationId)
    : await listUsableExternalMcpConnections({
        organizationId: actor.organizationId,
        orgMembershipId: actor.memberId,
        teamIds: teams.map((team) => team.id),
      })
  const bindings: SecretBindingStatus[] = []
  for (const connection of connections) {
    const binding = await getSecretBinding(actor.organizationId, connection.id)
    if (binding)
      bindings.push(await secretBindingStatus(actor, connection, binding))
  }
  return { canManage: actor.admin, definitions, bindings }
}

export async function approveSecretBinding(
  actor: SecretsActor,
  connectionId: DenTypeId<"externalMcpConnection">,
  revision: number,
) {
  const connection = await usableSecretConnection(actor, connectionId)
  const binding = await getSecretBinding(actor.organizationId, connectionId)
  if (
    !binding ||
    binding.revision !== revision ||
    binding.identity !== secretConnectionIdentity(connection)
  )
    throw new SecretSetupError(
      "stale_revision",
      "This connection changed. Review its current destination before approving.",
    )
  await db
    .insert(SecretBindingApprovalTable)
    .values({
      id: randomUUID(),
      organizationId: actor.organizationId,
      memberId: actor.memberId,
      connectionId,
      revision,
      identity: binding.identity,
    })
    .onDuplicateKeyUpdate({ set: { revision, identity: binding.identity } })
}

export async function resolveSecretHeaders(
  actor: Pick<SecretsActor, "organizationId" | "memberId">,
  connectionId: DenTypeId<"externalMcpConnection">,
) {
  const connection = await usableSecretConnection(actor, connectionId)
  const binding = await getSecretBinding(actor.organizationId, connectionId)
  if (!binding || !binding.headers.length)
    return { headers: new Headers(), secrets: new Set<string>() }
  const member = await activeSecretMember(actor.organizationId, actor.memberId)
  const status = await secretBindingStatus(
    { ...actor, userId: member.userId, admin: false },
    connection,
    binding,
  )
  if (!status.ready)
    throw new SecretSetupError(
      "secret_setup_required",
      status.needsAdmin
        ? "Ask a workspace admin to update the shared connection setup."
        : status.missingLabels.length
          ? `Add ${status.missingLabels.join(", ")} in Secrets and variables.`
          : "Approve this connection's credential destination in Secrets and variables.",
    )
  const values = new Map<string, string>()
  const secrets = new Set<string>()
  for (const [name, id] of Object.entries(binding.definitions)) {
    const [definition] = await db
      .select()
      .from(SecretDefinitionTable)
      .where(
        and(
          eq(SecretDefinitionTable.organizationId, actor.organizationId),
          eq(SecretDefinitionTable.id, id),
          eq(SecretDefinitionTable.retired, false),
        ),
      )
      .limit(1)
    if (!definition)
      throw new SecretSetupError(
        "secret_setup_required",
        "Ask a workspace admin to update this connection.",
      )
    const [value] = await db
      .select({ value: SecretValueTable.encryptedValue })
      .from(SecretValueTable)
      .where(
        valueWhere(
          { ...actor, userId: member.userId, admin: false },
          definition,
        ),
      )
      .limit(1)
    if (value?.value === null || value?.value === undefined)
      throw new SecretSetupError(
        "missing_value",
        "Add the required value before using this connection.",
      )
    values.set(name, value.value)
    if (definition.kind === "secret") secrets.add(value.value)
  }
  const headers = new Headers()
  for (const header of binding.headers) {
    const expanded = expandTemplate(header.template, values)
    headers.set(header.name, expanded)
    if (
      templateNames(header.template).some((name) =>
        secrets.has(values.get(name) ?? ""),
      )
    )
      secrets.add(expanded)
  }
  return {
    headers,
    secrets,
    identity: binding.identity,
    endpoint: binding.endpoint,
  }
}

export async function secretConnectionReady(
  connection: NonNullable<Awaited<ReturnType<typeof getExternalMcpConnection>>>,
  memberId: DenTypeId<"member">,
) {
  const binding = await getSecretBinding(
    connection.organizationId,
    connection.id,
  )
  if (!binding) return true
  try {
    const member = await activeSecretMember(connection.organizationId, memberId)
    return (
      await secretBindingStatus(
        {
          organizationId: connection.organizationId,
          memberId,
          userId: member.userId,
          admin: false,
        },
        connection,
        binding,
      )
    ).ready
  } catch {
    return false
  }
}
