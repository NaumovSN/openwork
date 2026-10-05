import { and, eq, inArray, isNotNull, isNull, or } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable, ExternalMcpConnectionAccessGrantTable, InvitationTable, MemberTable, OrganizationTable, ScimGroupMemberTable, ScimGroupTable, ScimProviderTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { withGatewayUsageEntitlementMutation } from "@openwork-ee/den-db/gateway-usage-limits"
import { organizationRoleValueSatisfies } from "./organization-role-hierarchy.js"

export type OrganizationAdminTeam = { id: string; name: string }

export type TeamMutationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Share this lock with invitations and SCIM teardown so a concurrent grant cannot
// turn an already-authorized routine membership edit into a role assignment.
export function withOrganizationTeamMutation<T>(
  organizationId: typeof TeamTable.$inferSelect.organizationId,
  mutation: (tx: TeamMutationTransaction) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId)).for("update")
    return mutation(tx)
  })
}

export function withOrganizationMembershipUsageMutation<T>(
  organizationId: typeof TeamTable.$inferSelect.organizationId,
  mutation: (tx: TeamMutationTransaction) => Promise<T>,
  memberIds: typeof MemberTable.$inferSelect.id[] | ((tx: TeamMutationTransaction) => Promise<typeof MemberTable.$inferSelect.id[]>),
) {
  return withOrganizationTeamMutation(organizationId, async (tx) => {
    const affected = [...new Set(typeof memberIds === "function" ? await memberIds(tx) : memberIds)]
    const memberships = () => affected.length === 0 ? Promise.resolve([]) : tx
      .select({ memberId: TeamMemberTable.orgMembershipId, teamId: TeamMemberTable.teamId })
      .from(TeamMemberTable)
      .innerJoin(TeamTable, and(eq(TeamTable.id, TeamMemberTable.teamId), eq(TeamTable.organizationId, organizationId)))
      .where(inArray(TeamMemberTable.orgMembershipId, affected))
    const before = await memberships()
    const result = await withGatewayUsageEntitlementMutation(tx, organizationId, () => mutation(tx), affected)
    const afterRows = await memberships()
    const after = new Set(afterRows.map((row) => `${row.memberId}:${row.teamId}`))
    const removed = [...new Set(before.flatMap((row) => row.memberId && !after.has(`${row.memberId}:${row.teamId}`) ? [row.memberId] : []))]
    // Inspect actual lost associations, not a returned Response's truthiness:
    // denied edits and identical member-list replacements must preserve keys.
    if (removed.length > 0) await deleteUnreachableMemberApiKeys(tx, organizationId, removed, afterRows)
    return result
  })
}

// A personal key needs a direct grant (org-wide, member or team) at enrollment,
// so it is deleted once none of those still reaches its owner.
async function deleteUnreachableMemberApiKeys(
  tx: TeamMutationTransaction,
  organizationId: typeof TeamTable.$inferSelect.organizationId,
  memberIds: typeof MemberTable.$inferSelect.id[],
  memberships: { memberId: typeof TeamMemberTable.$inferSelect.orgMembershipId; teamId: typeof TeamTable.$inferSelect.id }[],
) {
  const keys = await tx.select({ id: ConnectedAccountTable.id, memberId: ConnectedAccountTable.orgMembershipId, connectionId: ConnectedAccountTable.providerId })
    .from(ConnectedAccountTable)
    .where(and(
      eq(ConnectedAccountTable.organizationId, organizationId),
      eq(ConnectedAccountTable.tokenType, "api_key"),
      inArray(ConnectedAccountTable.orgMembershipId, memberIds),
    ))
  if (keys.length === 0) return
  const teamIds = [...new Set(memberships.map((row) => row.teamId))]
  const grants = await tx.select({
    connectionId: ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId,
    orgWide: ExternalMcpConnectionAccessGrantTable.orgWide,
    memberId: ExternalMcpConnectionAccessGrantTable.orgMembershipId,
    teamId: ExternalMcpConnectionAccessGrantTable.teamId,
  })
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(and(
      eq(ExternalMcpConnectionAccessGrantTable.organizationId, organizationId),
      isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
      or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        inArray(ExternalMcpConnectionAccessGrantTable.orgMembershipId, memberIds),
        teamIds.length > 0 ? inArray(ExternalMcpConnectionAccessGrantTable.teamId, teamIds) : undefined,
      ),
    ))
  const reaches = (key: (typeof keys)[number]) => grants.some((grant) => grant.connectionId === key.connectionId && (
    grant.orgWide
    || grant.memberId === key.memberId
    || memberships.some((row) => row.memberId === key.memberId && row.teamId === grant.teamId)
  ))
  const unreachable = keys.flatMap((key) => reaches(key) ? [] : [key.id])
  if (unreachable.length > 0) await tx.delete(ConnectedAccountTable).where(inArray(ConnectedAccountTable.id, unreachable))
}

export function effectiveOrganizationRole(directRole: string, adminTeams: readonly OrganizationAdminTeam[]) {
  return adminTeams.length > 0 && !organizationRoleValueSatisfies({ roleValue: directRole, requiredRole: "admin" })
    ? `${directRole},admin`
    : directRole
}

export async function invitationHasAdminTeam(tx: TeamMutationTransaction, invitation: Pick<typeof InvitationTable.$inferSelect, "id" | "organizationId" | "teamId">) {
  const teams = await tx.select({ id: TeamTable.id }).from(TeamTable)
    .leftJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .leftJoin(MemberTable, and(eq(MemberTable.id, TeamMemberTable.orgMembershipId), isNull(MemberTable.removedAt)))
    .where(and(
      eq(TeamTable.organizationId, invitation.organizationId),
      eq(TeamTable.grantsOrganizationAdmin, true),
      or(eq(MemberTable.inviteId, invitation.id), invitation.teamId ? eq(TeamTable.id, invitation.teamId) : undefined),
    )).limit(1)
  return teams.length > 0
}

// Never cache authority: IdP removals and designation changes apply on the next check.
export async function listOrganizationAdminTeamGrants(organizationId: typeof TeamTable.$inferSelect.organizationId, database: typeof db | TeamMutationTransaction = db) {
  return database.select({ memberId: MemberTable.id, id: TeamTable.id, name: TeamTable.name })
    .from(TeamTable)
    .innerJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .innerJoin(MemberTable, and(
      eq(MemberTable.id, TeamMemberTable.orgMembershipId),
      eq(MemberTable.organizationId, TeamTable.organizationId),
      isNull(MemberTable.removedAt),
    ))
    .leftJoin(ScimGroupTable, and(eq(ScimGroupTable.teamId, TeamTable.id), eq(ScimGroupTable.organizationId, organizationId)))
    .leftJoin(ScimProviderTable, and(
      eq(ScimProviderTable.providerId, ScimGroupTable.providerId),
      eq(ScimProviderTable.organizationId, organizationId),
    ))
    .leftJoin(ScimGroupMemberTable, and(
      eq(ScimGroupMemberTable.groupId, ScimGroupTable.id),
      eq(ScimGroupMemberTable.providerId, ScimProviderTable.providerId),
      eq(ScimGroupMemberTable.organizationId, organizationId),
      eq(ScimGroupMemberTable.teamMemberId, TeamMemberTable.id),
      eq(ScimGroupMemberTable.orgMembershipId, MemberTable.id),
      eq(ScimGroupMemberTable.remoteUserId, MemberTable.userId),
    ))
    .where(and(
      eq(TeamTable.organizationId, organizationId),
      eq(TeamTable.grantsOrganizationAdmin, true),
      // A mapped team projection is not itself authority. Orphaned projections
      // fail closed; disconnected teams require their own manual reapproval.
      or(
        isNull(ScimGroupTable.id),
        eq(ScimProviderTable.groupMappingMode, "metadata_only"),
        and(eq(ScimProviderTable.groupMappingMode, "create_teams"), isNotNull(ScimGroupMemberTable.id)),
      ),
    ))
}

export async function resolveOrganizationMemberAuthority(input: {
  organizationId: typeof MemberTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}) {
  const [members, grants] = await Promise.all([
    db.select().from(MemberTable).where(and(
      eq(MemberTable.id, input.memberId),
      eq(MemberTable.organizationId, input.organizationId),
      isNull(MemberTable.removedAt),
    )).limit(1),
    listOrganizationAdminTeamGrants(input.organizationId),
  ])
  const member = members[0]
  if (!member?.userId) return null
  const adminTeams = grants.filter((grant) => grant.memberId === member.id).map(({ id, name }) => ({ id, name }))
  return { ...member, directRole: member.role, role: effectiveOrganizationRole(member.role, adminTeams), adminTeams }
}
