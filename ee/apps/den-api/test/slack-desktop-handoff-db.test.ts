import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { eq } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConnectedAccountTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  MemberTable,
  OAuthAccessTokenTable,
  OrganizationTable,
  SlackAssistantDesktopHandoffTable as Handoff,
  SlackAssistantEventTable as Event,
  SlackAssistantIdentityTable as Identity,
  SlackAssistantInstallationTable as Installation,
  SlackAssistantRunTokenTable as RunToken,
} from "@openwork-ee/den-db/schema"
import { RemoteSessionCommandTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { RemoteSessionCommandSessionReport } from "@openwork/types/automations"
import { SlackApiError, type SlackCall } from "../src/slack-assistant/protocol.js"

// Only opt into the explicitly isolated DB, never the developer's regular Den.
const databaseUrl = process.env.DEN_SLACK_TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
if (databaseUrl && !new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("Slack DB tests require an isolated *_test database")
process.env.DATABASE_URL = databaseUrl ?? "mysql://root:password@127.0.0.1:3318/openwork_slack_test"
process.env.DEN_DB_ENCRYPTION_KEY = "desktop-handoff-test-encryption-key-not-production"
process.env.BETTER_AUTH_SECRET = "desktop-handoff-better-auth-test-secret-not-production"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.DEN_API_PUBLIC_URL = "http://localhost:8790"

suite("Slack desktop handoff: real database", () => {
  let db: (typeof import("../src/db.js"))["db"]
  let handoffs: typeof import("../src/slack-assistant/desktop-handoff.js")
  let store: (typeof import("../src/remote-sessions/commands.js"))["databaseRemoteSessionCommandStore"]
  let remote: typeof import("../src/mcp/remote-session-capabilities.js")
  let mint: (typeof import("../src/mcp/headless-run-token-mint.js"))["mintHeadlessRunMcpToken"]
  const orgId = createDenTypeId("organization")
  const connectionId = createDenTypeId("externalMcpConnection")
  const memberId = createDenTypeId("member")
  const userId = createDenTypeId("user")
  const otherUserId = createDenTypeId("user")
  const otherMemberId = createDenTypeId("member")
  const posts: { token: string; body: Record<string, unknown> }[] = []
  let slackFailure: SlackApiError | null = null
  let clock = Date.now()
  const slack =
    (token: string): SlackCall =>
    async (method, body) => {
      if (method !== "chat.postMessage") throw new Error(`unexpected ${method}`)
      if (slackFailure) throw slackFailure
      posts.push({ token, body })
      return { ok: true, ts: `${posts.length}.1` }
    }
  const sweep = async () => {
    clock += 10_000
    return handoffs.sweepSlackDesktopHandoffs({ slack, commandStore: store, now: () => clock })
  }

  /** A Slack run whose reply went to a private DM thread, with the MCP token Den minted for it. */
  async function slackRun(user = userId) {
    const eventId = createHash("sha256").update(randomUUID()).digest("hex")
    await db.insert(Event).values({
      id: eventId,
      connectionId,
      teamId: "TTEST",
      slackUserId: "UACTOR1",
      channelId: "CSHARED",
      threadTs: "100.1",
      payload: JSON.stringify({ type: "app_mention" }),
      checkpoint: JSON.stringify({ channel: "DPRIVATE", threadTs: "200.1", recipientUserId: "UACTOR1", recipientTeamId: "TTEST" }),
      status: "running",
    })
    const minted = await mint({ userId: user, organizationId: orgId })
    await handoffs.recordSlackRunToken({ ...minted, userId: user, messageId: `msg_${eventId}` })
    return { eventId, ...minted }
  }

  async function queuedCommand(ttlMs = 600_000) {
    return store.enqueue({
      organizationId: orgId,
      ownerMemberId: memberId,
      createdByUserId: userId,
      title: "Desktop task",
      prompt: "Tidy the notes",
      ttlMs,
    })
  }

  async function linkedCommand(ttlMs?: number) {
    const run = await slackRun()
    const command = await queuedCommand(ttlMs)
    expect(await handoffs.linkDesktopCommandToSlack({ commandId: command.id, organizationId: orgId, userId, runTokenId: run.tokenId })).toBe(true)
    return command
  }

  async function deliver(commandId: string) {
    expect(await store.claim({ commandId, organizationId: orgId, ownerMemberId: memberId, runnerId: "runner-1", now: Date.now() })).not.toBeNull()
    expect(await store.complete({ commandId, runnerId: "runner-1", status: "delivered", sessionId: "ses_desk", workspaceId: "ws_desk" })).not.toBeNull()
  }

  async function report(commandId: string, body: Omit<RemoteSessionCommandSessionReport, "observedAt">) {
    expect(
      await store.report({ ...body, observedAt: Date.now(), commandId, organizationId: orgId, ownerMemberId: memberId, runnerId: "runner-1" }),
    ).toBe("reported")
  }

  async function handoff(commandId: string) {
    return (await db.select().from(Handoff).where(eq(Handoff.commandId, commandId)))[0]
  }

  beforeAll(async () => {
    db = (await import("../src/db.js")).db
    handoffs = await import("../src/slack-assistant/desktop-handoff.js")
    store = (await import("../src/remote-sessions/commands.js")).databaseRemoteSessionCommandStore
    remote = await import("../src/mcp/remote-session-capabilities.js")
    mint = (await import("../src/mcp/headless-run-token-mint.js")).mintHeadlessRunMcpToken
    await db.insert(OrganizationTable).values({
      id: orgId,
      name: "Handoff test",
      slug: orgId,
      metadata: { complimentaryAccess: { openworkWeb: true }, capabilities: { slackAssistant: true } },
    })
    await db.insert(AuthUserTable).values({ id: userId, name: "Actor", email: `${userId}@example.test` })
    await db.insert(AuthUserTable).values({ id: otherUserId, name: "Other", email: `${otherUserId}@example.test` })
    await db.insert(MemberTable).values({ id: memberId, organizationId: orgId, userId, role: "member" })
    await db.insert(MemberTable).values({ id: otherMemberId, organizationId: orgId, userId: otherUserId, role: "member" })
    await db.insert(ExternalMcpConnectionTable).values({
      id: connectionId,
      organizationId: orgId,
      name: "Slack",
      url: "https://mcp.slack.com/mcp",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
    })
    await db.insert(ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: orgId,
      externalMcpConnectionId: connectionId,
      orgWide: true,
      createdByOrgMembershipId: memberId,
    })
    await db.insert(Installation).values({
      connectionId,
      organizationId: orgId,
      enabled: true,
      signingSecret: "secret",
      teamId: "TTEST",
      appId: "ATEST",
      botUserId: "UBOT",
      botToken: "bot-token",
    })
    await db.insert(Identity).values({ id: randomUUID(), connectionId, memberId, teamId: "TTEST", slackUserId: "UACTOR1" })
    await db.insert(ConnectedAccountTable).values({
      id: createDenTypeId("connectedAccount"),
      organizationId: orgId,
      orgMembershipId: memberId,
      providerId: connectionId,
      accessToken: "user-token",
    })
  })

  beforeEach(() => {
    posts.length = 0
    slackFailure = null
  })

  afterAll(async () => {
    if (!db) return
    await db.delete(Handoff).where(eq(Handoff.organizationId, orgId))
    await db.delete(RunToken).where(eq(RunToken.connectionId, connectionId))
    await db.delete(RemoteSessionCommandTable).where(eq(RemoteSessionCommandTable.org_id, orgId))
    await db.delete(OAuthAccessTokenTable).where(eq(OAuthAccessTokenTable.referenceId, orgId))
    await db.delete(Event).where(eq(Event.connectionId, connectionId))
    await db.delete(Identity).where(eq(Identity.connectionId, connectionId))
    await db.delete(Installation).where(eq(Installation.connectionId, connectionId))
    await db.delete(ConnectedAccountTable).where(eq(ConnectedAccountTable.organizationId, orgId))
    await db.delete(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.organizationId, orgId))
    await db.delete(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, connectionId))
    await db.delete(MemberTable).where(eq(MemberTable.organizationId, orgId))
    await db.delete(OrganizationTable).where(eq(OrganizationTable.id, orgId))
    await db.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
    await db.delete(AuthUserTable).where(eq(AuthUserTable.id, otherUserId))
  })

  test("a desktop handoff made with a Slack run's token records the thread its reply went to", async () => {
    const run = await slackRun()
    const { verifyMcpRequest } = await import("../src/mcp/auth.js")
    const { headlessRunTokenId } = await import("../src/mcp/headless-run-token.js")
    const principal = await verifyMcpRequest(new Headers({ authorization: `Bearer ${run.token}` }))
    if (principal instanceof Response) throw new Error(`token rejected: ${principal.status}`)
    expect(headlessRunTokenId(principal.payload)).toBe(run.tokenId)

    const result = await remote.executeRemoteSessionCapability(
      {
        action: "create",
        organizationId: orgId,
        userId,
        hasWriteScope: true,
        body: { target: "desktop", prompt: "Tidy the notes" },
        headlessRunTokenId: headlessRunTokenId(principal.payload),
      },
      {
        ...remote.DEFAULT_REMOTE_SESSION_DEPS,
        getOpenWorkWebAccess: async () => ({ hasAccess: true }),
        desktopPresence: async () => ({ connected: true, ownerMemberId: memberId }),
      },
    )
    expect(result.structuredContent).toMatchObject({ state: "queued", resultPostedInThread: true })
    const commandId = String(result.structuredContent?.commandId)
    expect(await handoff(commandId)).toMatchObject({
      eventId: run.eventId,
      userId,
      teamId: "TTEST",
      channelId: "DPRIVATE",
      threadTs: "200.1",
      recipientUserId: "UACTOR1",
      postedOutcome: null,
    })
  })

  test("tokens of another member, other clients, or unknown ids link nothing", async () => {
    const command = await queuedCommand()
    const foreign = await slackRun(otherUserId)
    expect(await handoffs.linkDesktopCommandToSlack({ commandId: command.id, organizationId: orgId, userId, runTokenId: foreign.tokenId })).toBe(false)
    const plain = createDenTypeId("oauthAccessToken")
    await db.insert(OAuthAccessTokenTable).values({
      id: plain,
      token: randomUUID(),
      clientId: "some-oauth-client",
      userId,
      referenceId: orgId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: "[]",
    })
    await db.insert(RunToken).values({ tokenId: plain, connectionId, eventId: foreign.eventId, userId, expiresAt: new Date(Date.now() + 60_000) })
    expect(await handoffs.linkDesktopCommandToSlack({ commandId: command.id, organizationId: orgId, userId, runTokenId: plain })).toBe(false)
    expect(await handoffs.linkDesktopCommandToSlack({ commandId: command.id, organizationId: orgId, userId, runTokenId: "not-a-token" })).toBe(false)
    const own = await slackRun()
    expect(await handoffs.linkDesktopCommandToSlack({ commandId: command.id, organizationId: createDenTypeId("organization"), userId, runTokenId: own.tokenId })).toBe(false)
    expect(await handoff(command.id)).toBeUndefined()
  })

  test("waiting posts once per episode and the finished answer posts exactly once, even with two sweepers", async () => {
    const command = await linkedCommand()
    await deliver(command.id)
    await report(command.id, { status: "running" })
    await sweep()
    expect(posts).toHaveLength(0)

    await report(command.id, { status: "waiting", waitingFor: "permission" })
    await sweep()
    await sweep()
    expect(posts.map((post) => post.body.text)).toEqual(["<@UACTOR1> Your desktop is waiting for you to approve something in OpenWork."])
    expect(posts[0]).toMatchObject({ token: "bot-token", body: { channel: "DPRIVATE", thread_ts: "200.1", unfurl_links: false } })

    await report(command.id, { status: "running" })
    await sweep()
    await report(command.id, { status: "waiting", waitingFor: "question" })
    await sweep()
    expect(posts).toHaveLength(2)

    await report(command.id, { status: "idle", finalText: "All tidy. Ping <!channel> about <https://x.example|this>." })
    clock += 10_000
    await Promise.all([
      handoffs.sweepSlackDesktopHandoffs({ slack, commandStore: store, now: () => clock }),
      handoffs.sweepSlackDesktopHandoffs({ slack, commandStore: store, now: () => clock }),
    ])
    await sweep()
    await sweep()
    const finished = posts.slice(2).map((post) => String(post.body.text))
    expect(finished).toEqual([
      "<@UACTOR1> Your desktop finished: All tidy. Ping &lt;!channel&gt; about &lt;https://x.example|this&gt;.",
    ])
    expect((await handoff(command.id))?.postedOutcome).toBe("finished")
  })

  test("a desktop session error posts the failure once", async () => {
    const command = await linkedCommand()
    await deliver(command.id)
    await report(command.id, { status: "error", error: { code: "provider_error", message: "The model provider refused the request." } })
    await sweep()
    await sweep()
    expect(posts.map((post) => post.body.text)).toEqual([
      "<@UACTOR1> The task on your desktop failed: The model provider refused the request. It's still open in OpenWork on that computer.",
    ])
  })

  test("a command that expires unclaimed or fails at delivery posts a short failure once", async () => {
    const expired = await linkedCommand(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await sweep()
    await sweep()
    expect(posts.map((post) => post.body.text)).toEqual([expect.stringContaining("didn't pick up the task in time")])
    expect((await handoff(expired.id))?.postedOutcome).toBe("expired")

    posts.length = 0
    const failed = await linkedCommand()
    expect(await store.claim({ commandId: failed.id, organizationId: orgId, ownerMemberId: memberId, runnerId: "runner-1", now: Date.now() })).not.toBeNull()
    await store.complete({ commandId: failed.id, runnerId: "runner-1", status: "failed", error: { code: "provider_auth_failed", message: "Sign in to your model provider again" } })
    await sweep()
    await sweep()
    expect(posts.map((post) => post.body.text)).toEqual([
      "<@UACTOR1> The task couldn't start on your desktop: Sign in to your model provider again.",
    ])
    expect((await handoff(failed.id))?.postedOutcome).toBe("undeliverable")
  })

  test("a transient Slack error retries; a permanent one or a disabled assistant stops posting", async () => {
    const command = await linkedCommand()
    await deliver(command.id)
    await report(command.id, { status: "idle", finalText: "Done" })
    slackFailure = new SlackApiError("ratelimited", 1_000)
    await sweep()
    expect(posts).toHaveLength(0)
    expect(await handoff(command.id)).toMatchObject({ postedOutcome: null, attempts: 1 })
    slackFailure = null
    await sweep()
    expect(posts.map((post) => post.body.text)).toEqual(["<@UACTOR1> Your desktop finished: Done"])

    posts.length = 0
    const archived = await linkedCommand()
    await deliver(archived.id)
    await report(archived.id, { status: "idle", finalText: "Done" })
    slackFailure = new SlackApiError("channel_not_found")
    await sweep()
    slackFailure = null
    await sweep()
    expect(posts).toHaveLength(0)
    expect((await handoff(archived.id))?.postedOutcome).toBe("abandoned")

    const paused = await linkedCommand()
    await deliver(paused.id)
    await report(paused.id, { status: "idle", finalText: "Done" })
    await db.update(Installation).set({ enabled: false }).where(eq(Installation.connectionId, connectionId))
    try {
      await sweep()
    } finally {
      await db.update(Installation).set({ enabled: true }).where(eq(Installation.connectionId, connectionId))
    }
    expect(posts).toHaveLength(0)
    expect((await handoff(paused.id))?.postedOutcome).toBe("abandoned")
  })

  test("deleting the connector removes its handoffs and run tokens", async () => {
    await linkedCommand()
    const { deleteExternalMcpConnection } = await import("../src/capability-sources/external-mcp-connections.js")
    expect(await deleteExternalMcpConnection({ organizationId: orgId, connectionId })).toBe(true)
    expect(await db.select().from(Handoff).where(eq(Handoff.connectionId, connectionId))).toHaveLength(0)
    expect(await db.select().from(RunToken).where(eq(RunToken.connectionId, connectionId))).toHaveLength(0)
  })
})
