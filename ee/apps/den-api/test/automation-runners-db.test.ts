import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  AutomationRevisionTable,
  AutomationRunEventTable,
  AutomationRunnerNotificationTable,
  AutomationRunnerTable,
  AutomationRunTable,
  AutomationTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import {
  automationDesktopRunnerRegistrationSchema,
  createAutomationSchema,
  type AutomationDesktopRunnerCapability,
} from "@openwork/types/automations"
import { createHeadlessRunnerClient } from "../src/headless-runner/client.js"

// Only opt into an explicitly isolated database, never a developer's regular Den.
const databaseUrl = process.env.DEN_AUTOMATION_RUNNERS_TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
if (databaseUrl && !new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("Automation runner DB tests require an isolated *_test database")
process.env.DATABASE_URL = databaseUrl ?? "mysql://root:password@127.0.0.1:3306/openwork_automation_runners_test"
process.env.DEN_DB_ENCRYPTION_KEY = "automation-runners-test-encryption-key-00"
process.env.BETTER_AUTH_SECRET = "automation-runners-test-auth-secret-0000"
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
process.env.CORS_ORIGINS = "http://127.0.0.1:8790"

const DAY_MS = 24 * 60 * 60_000
const HEADLESS = "openwork-headless-agent-v1"
const ZEN = { providerId: "opencode", modelId: "big-pickle", variant: null }

/** The smallest headless runner that answers every turn: one assistant reply, then completed. */
function answeringRunner(answer: string) {
  const prompts: string[] = []
  let sessions = 0
  const turns = new Map<string, number>()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.pathname === "/v1/models") return json(200, { defaultModel: "gwm_default", models: [{ id: "gwm_default", name: "Default" }] })
    if (url.pathname === "/v1/sessions") return json(201, { id: `hs_runners_${++sessions}` })
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname.endsWith("/turns")) {
      prompts.push(String(body.prompt))
      turns.set(String(body.messageId), 0)
      return json(202, { state: "accepted" })
    }
    const messageId = url.searchParams.get("messageId") ?? ""
    const reads = (turns.get(messageId) ?? 0) + 1
    turns.set(messageId, reads)
    const done = reads > 1
    return json(200, {
      turns: [{ messageId, status: done ? "completed" : "running", error: null, model: "gwm_default", usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2 } }],
      messages: done ? [{ messageId, role: "user", text: "go" }, { messageId, role: "assistant", text: answer, toolCalls: [] }] : [],
      finalAssistantText: done ? answer : "",
    })
  }
  const client = createHeadlessRunnerClient({
    config: { url: "http://headless-runner:8795", token: "t".repeat(40) },
    fetch: fetchImpl,
    mintToken: async () => ({ token: "ow_mcp_at_test" }),
  })
  return { client, prompts }
}

suite("automation runners: real database", () => {
  let db: (typeof import("../src/db.js"))["db"]
  let repositoryModule: typeof import("../src/automations/repository.js")
  let serviceModule: typeof import("../src/automations/service.js")
  let routes: typeof import("../src/routes/automations/index.js")
  let automations: InstanceType<(typeof import("../src/automations/service.js"))["AutomationService"]>
  let executor: typeof import("../src/automations/headless-agent-executor.js")
  const headless = answeringRunner("Two launch decisions landed overnight.")
  const userId = createDenTypeId("user")
  const orgA = createDenTypeId("organization")
  const orgB = createDenTypeId("organization")
  const memberA = createDenTypeId("member")
  const memberB = createDenTypeId("member")
  const scopeA = { organizationId: orgA, ownerMemberId: memberA }
  const scopeB = { organizationId: orgB, ownerMemberId: memberB }
  // One desktop install signed in to both organizations.
  const install = randomUUID()
  const fleetPrefix = `fleet-${randomUUID().slice(0, 8)}`
  const automationIds: string[] = []

  const registration = (runnerId: string, capabilities: AutomationDesktopRunnerCapability[] = []) =>
    automationDesktopRunnerRegistrationSchema.parse({
      runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities,
      appVersion: "0.19.0", platform: "darwin", concurrency: 1,
    })

  function runnerRow(input: {
    id: string
    organizationId: string
    ownerMemberId: string
    lastSeenAt: number
    capabilities?: AutomationDesktopRunnerCapability[]
  }): typeof AutomationRunnerTable.$inferInsert {
    const seen = new Date(input.lastSeenAt)
    return {
      id: input.id, organization_id: input.organizationId, owner_member_id: input.ownerMemberId,
      protocol_version: 1, supported_execution_targets: ["desktop"], capabilities: input.capabilities ?? [],
      app_version: "0.18.0", platform: "darwin", concurrency: 1, last_seen_at: seen, created_at: seen, updated_at: seen,
    }
  }

  async function desktopsOf(scope: typeof scopeA) {
    return (await automations.executionTargets(scope)).items.flatMap((item) => (item.kind === "desktop" ? [item] : []))
  }

  async function desktopAutomation(name: string, scope: typeof scopeA, workspaceId: string | null) {
    const created = await repositoryModule.automationRepository.create({
      ...scope,
      now: Date.now(),
      definition: createAutomationSchema.parse({
        name,
        instructions: `Run ${name}`,
        schedule: { kind: "daily", timezone: "UTC", hour: 8, minute: 0 },
        model: ZEN,
        ...(workspaceId ? { workspaceId } : {}),
      }),
    })
    automationIds.push(created.automation.id)
    return created
  }

  async function cloudAutomation(name: string, action?: unknown) {
    const created = await repositoryModule.automationRepository.create({
      ...scopeA,
      now: Date.now(),
      definition: createAutomationSchema.parse({
        name,
        schedule: { kind: "daily", timezone: "UTC", hour: 8, minute: 0 },
        action: action ?? { kind: "agent", instructions: `Run ${name}`, model: ZEN },
        executionTarget: "cloud",
      }),
    })
    automationIds.push(created.automation.id)
    return created
  }

  async function runRow(runId: string) {
    const [run] = await db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, runId)).limit(1)
    if (!run) throw new Error("run not found")
    return run
  }

  async function settled(runId: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = await runRow(runId)
      if (["succeeded", "failed", "cancelled", "skipped"].includes(run.status)) return run
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("run did not settle")
  }

  function useAnsweringRunner() {
    serviceModule.configureHeadlessAgentExecutor((input) => executor.executeHeadlessAgent(input, {
      client: headless.client,
      ownerUserId: async () => userId,
      stillHeadless: async () => true,
      sleep: async () => {},
      pollIntervalMs: 0,
    }))
  }

  /** The real routes behind a stand-in for the session middleware; `x-test-agent` marks an MCP tool call. */
  function routedApp() {
    const app = new Hono()
    app.use("*", async (c, next) => {
      const now = new Date()
      c.set("user", { id: userId, name: "Owner", email: `${userId}@example.test`, emailVerified: true, image: null, createdAt: now, updatedAt: now })
      c.set("session", {
        id: c.req.header("x-test-agent") ? "mcp_internal" : `ses_${userId}`,
        token: "test", userId, activeOrganizationId: null, activeTeamId: null,
        expiresAt: new Date(Date.now() + 60_000), createdAt: now, updatedAt: now, ipAddress: null, userAgent: null,
      })
      c.set("apiKey", null)
      await next()
    })
    routes.registerAutomationRoutes(app, { service: automations })
    return (path: string, init: { method?: string; body?: unknown; organizationId?: string; agent?: boolean; rawBody?: string } = {}) => app.request(`http://den.local${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-openwork-org-id": init.organizationId ?? orgA,
        ...(init.agent ? { "x-test-agent": "1" } : {}),
        ...(init.body !== undefined || init.rawBody !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    })
  }

  beforeAll(async () => {
    db = (await import("../src/db.js")).db
    repositoryModule = await import("../src/automations/repository.js")
    serviceModule = await import("../src/automations/service.js")
    routes = await import("../src/routes/automations/index.js")
    executor = await import("../src/automations/headless-agent-executor.js")
    useAnsweringRunner()
    automations = new serviceModule.AutomationService({
      cloudRuntime: async () => "headless",
      getOpenWorkWebAccess: async () => ({ hasAccess: false }),
    })
    await db.insert(AuthUserTable).values({ id: userId, name: "Owner", email: `${userId}@example.test` })
    for (const organizationId of [orgA, orgB]) {
      await db.insert(OrganizationTable).values({
        id: organizationId,
        name: "Automation runners test",
        slug: organizationId,
        metadata: { plan: { tier: "team" }, capabilities: { headlessAutomations: true } },
      })
    }
    await db.insert(MemberTable).values([
      { id: memberA, organizationId: orgA, userId, role: "member" },
      { id: memberB, organizationId: orgB, userId, role: "member" },
    ])
  })

  afterAll(async () => {
    if (!db) return
    if (automationIds.length) {
      const runs = await db.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(inArray(AutomationRunTable.automation_id, automationIds))
      if (runs.length) await db.delete(AutomationRunEventTable).where(inArray(AutomationRunEventTable.run_id, runs.map((run) => run.id)))
      await db.delete(AutomationRunTable).where(inArray(AutomationRunTable.automation_id, automationIds))
      await db.delete(AutomationRevisionTable).where(inArray(AutomationRevisionTable.automation_id, automationIds))
      await db.delete(AutomationTable).where(inArray(AutomationTable.id, automationIds))
    }
    await db.delete(AutomationRunnerNotificationTable).where(inArray(AutomationRunnerNotificationTable.organization_id, [orgA, orgB]))
    await db.delete(AutomationRunnerTable).where(inArray(AutomationRunnerTable.organization_id, [orgA, orgB]))
    await db.delete(MemberTable).where(inArray(MemberTable.id, [memberA, memberB]))
    await db.delete(OrganizationTable).where(inArray(OrganizationTable.id, [orgA, orgB]))
    await db.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
  })

  test("one desktop install is a runner in two organizations, and its pre-scoping row is replaced", async () => {
    // Keyed by the install id alone, as before: registering the same install
    // in another organization used to fail with an identity conflict.
    await db.insert(AutomationRunnerTable).values(runnerRow({ id: install, ...scopeA, lastSeenAt: Date.now() - 60_000 }))
    await automations.registerDesktopRunner(scopeB, registration(install))
    await automations.registerDesktopRunner(scopeA, registration(install))

    const rows = await db.select().from(AutomationRunnerTable).where(inArray(AutomationRunnerTable.organization_id, [orgA, orgB]))
    expect(rows.map((row) => row.id).sort()).toEqual([
      repositoryModule.automationRunnerRowId({ ...scopeA, runnerId: install }),
      repositoryModule.automationRunnerRowId({ ...scopeB, runnerId: install }),
    ].sort())
    const desktopsA = await desktopsOf(scopeA)
    const desktopsB = await desktopsOf(scopeB)
    expect(desktopsA).toHaveLength(1)
    expect(desktopsB).toHaveLength(1)
    expect(desktopsA[0]).toMatchObject({ connected: true, platform: "darwin", appVersion: "0.19.0" })
    expect(desktopsA[0]?.id).not.toBe(desktopsB[0]?.id)

    // Each organization's credential touches only its own row.
    const before = await db.select().from(AutomationRunnerTable).where(eq(AutomationRunnerTable.organization_id, orgB))
    await repositoryModule.automationRepository.touchDesktopRunner({ ...scopeA, runnerId: install, now: Date.now() + 5_000 })
    const after = await db.select().from(AutomationRunnerTable).where(eq(AutomationRunnerTable.organization_id, orgB))
    expect(after[0]?.last_seen_at.getTime()).toBe(before[0]?.last_seen_at.getTime())
  })

  test("the token route registers the same install in both organizations without a conflict", async () => {
    const request = routedApp()
    for (const organizationId of [orgA, orgB]) {
      const response = await request("/v1/automation-runners/token", { method: "POST", organizationId, body: registration(install) })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ eventsPath: "/v1/automation-runners/events" })
    }
    const listed = await request("/v1/automation-runners")
    expect(listed.status).toBe(200)
    const targets = await listed.json()
    expect(targets.items.at(-1)).toEqual({ kind: "cloud", available: true, runtime: "headless", cloudComputer: false })
  })

  test("a member may register any number of desktops; lookups see all of them", async () => {
    const now = Date.now()
    // 120 recent desktops without remote sessions and one older desktop with
    // them: the former 100-row window never reached it.
    const fleet = Array.from({ length: 120 }, (_, index) => runnerRow({
      id: `${fleetPrefix}-${index}`, ...scopeA, lastSeenAt: now - 1_000 - index, capabilities: ["model_attention_v1"],
    }))
    const remote = runnerRow({ id: `${fleetPrefix}-remote`, ...scopeA, lastSeenAt: now - 120_000, capabilities: ["model_attention_v1", "remote_session_v1"] })
    await db.insert(AutomationRunnerTable).values([...fleet, remote])
    try {
      expect(await repositoryModule.automationRepository.desktopRunnerCapabilityLastSeenAt({
        ...scopeA, capability: "remote_session_v1",
      })).toBe(now - 120_000)
      const desktops = await desktopsOf(scopeA)
      // The list is bounded for display, newest first; every desktop can still claim work.
      expect(desktops).toHaveLength(100)
      const seen = desktops.map((desktop) => desktop.lastSeenAt)
      expect(seen).toEqual([...seen].sort((left, right) => right - left))
      expect((await automations.desktopRunnerPresence(scopeA)).connected).toBe(true)
    } finally {
      await db.delete(AutomationRunnerTable).where(inArray(AutomationRunnerTable.id, [...fleet, remote].map((row) => row.id)))
    }
  })

  test("the scheduler forgets desktops unseen for 30 days and notifications older than 7 days, in bounded batches", async () => {
    const now = Date.now()
    const stale = Array.from({ length: 3 }, (_, index) => `${fleetPrefix}-stale-${index}`)
    const ids = [...stale, `${fleetPrefix}-recent`]
    await db.insert(AutomationRunnerTable).values([
      ...stale.map((id) => runnerRow({ id, ...scopeA, lastSeenAt: now - 31 * DAY_MS })),
      runnerRow({ id: `${fleetPrefix}-recent`, ...scopeA, lastSeenAt: now - 29 * DAY_MS }),
    ])
    const notification = (createdAt: number): typeof AutomationRunnerNotificationTable.$inferInsert => ({
      organization_id: orgA, owner_member_id: memberA, event_type: "work_available",
      run_id: createDenTypeId("automationRun"), created_at: new Date(createdAt),
    })
    // Ids grow with time, as they do in production.
    await db.insert(AutomationRunnerNotificationTable).values([
      notification(now - 9 * DAY_MS), notification(now - 8 * DAY_MS), notification(now - 8 * DAY_MS), notification(now - 6 * DAY_MS),
    ])
    const ours = async () => db.select().from(AutomationRunnerNotificationTable).where(and(
      eq(AutomationRunnerNotificationTable.organization_id, orgA),
      eq(AutomationRunnerNotificationTable.owner_member_id, memberA),
    ))

    // Each call removes at most `limit` rows per table.
    const repository = repositoryModule.automationRepository
    const bounded = await repository.pruneRunnerState({ runnersSeenBefore: now - 30 * DAY_MS, notificationsBefore: now - 7 * DAY_MS, limit: 2 })
    expect(bounded.runners).toBeLessThanOrEqual(2)
    expect(bounded.notifications).toBeLessThanOrEqual(2)
    expect(bounded.runners + bounded.notifications).toBeGreaterThan(0)

    // The scheduler tick finishes the job.
    await new serviceModule.AutomationService({ cloudRuntime: async () => "headless" }).tick({ now })
    const runners = await db.select({ id: AutomationRunnerTable.id }).from(AutomationRunnerTable)
      .where(inArray(AutomationRunnerTable.id, ids))
    expect(runners.map((row) => row.id)).toEqual([`${fleetPrefix}-recent`])
    const kept = await ours()
    expect(kept.map((row) => row.created_at.getTime())).toEqual([now - 6 * DAY_MS])
    await db.delete(AutomationRunnerTable).where(inArray(AutomationRunnerTable.id, ids))
    await db.delete(AutomationRunnerNotificationTable).where(eq(AutomationRunnerNotificationTable.organization_id, orgA))
  })

  test("work names the pinned workspace so only the desktop that has it claims the run", async () => {
    const pinned = await desktopAutomation("Laptop report", scopeA, "ws_laptop")
    const unpinned = await desktopAutomation("Anywhere report", scopeA, null)
    const elsewhere = await desktopAutomation("Other org report", scopeB, null)
    const pinnedRun = await automations.runNow(scopeA, pinned.automation.id)
    const unpinnedRun = await automations.runNow(scopeA, unpinned.automation.id)
    const elsewhereRun = await automations.runNow(scopeB, elsewhere.automation.id)
    if (!pinnedRun || !unpinnedRun || !elsewhereRun) throw new Error("expected queued runs")
    expect([pinnedRun.status, unpinnedRun.status, elsewhereRun.status]).toEqual(["queued", "queued", "queued"])

    // Two desktops of the same member see the same work; the other org's run stays with its own runner.
    const desk = randomUUID()
    await automations.registerDesktopRunner(scopeA, registration(desk))
    for (const runnerId of [install, desk]) {
      const work = await automations.discoverDesktopRunnerWork({ ...scopeA, runnerId, capabilities: [] })
      expect(work).toContainEqual({ runId: pinnedRun.id, executionTarget: "desktop", workspaceId: "ws_laptop" })
      // Unpinned items keep the released two-field shape.
      expect(work).toContainEqual({ runId: unpinnedRun.id, executionTarget: "desktop" })
      expect(work.some((item) => item.runId === elsewhereRun.id)).toBe(false)
    }
    const workB = await automations.discoverDesktopRunnerWork({ ...scopeB, runnerId: install, capabilities: [] })
    expect(workB).toEqual([{ runId: elsewhereRun.id, executionTarget: "desktop" }])

    // The desktop that has the workspace claims it; the other one no longer can.
    const assignment = await automations.claimDesktopRunner({ ...scopeA, runnerId: desk, capabilities: [] }, pinnedRun.id)
    expect(assignment).toMatchObject({ runId: pinnedRun.id, workspaceId: "ws_laptop", attempt: 1 })
    expect(await automations.claimDesktopRunner({ ...scopeA, runnerId: install, capabilities: [] }, pinnedRun.id)).toBeNull()
    expect((await runRow(pinnedRun.id)).lease_owner).toBe(`desktop:${memberA}:${desk}`)
    await automations.completeDesktopRunner({ ...scopeA, runnerId: desk, capabilities: [] }, pinnedRun.id, {
      attempt: 1, status: "succeeded", sessionId: "ses_desk", workspaceId: "ws_laptop", resultSummary: "Done.",
      usage: { inputTokens: 1, outputTokens: 1, costMicros: null }, error: null,
    })

    // A pinned run no connected desktop claims is missed for that reason.
    const lonely = await desktopAutomation("Lonely report", scopeA, "ws_gone")
    const lonelyRun = await automations.runNow(scopeA, lonely.automation.id)
    if (!lonelyRun) throw new Error("expected a queued run")
    await repositoryModule.automationRepository.touchDesktopRunner({ ...scopeA, runnerId: desk, now: Date.now() })
    await repositoryModule.automationRepository.expireUnclaimedDesktop({ now: Date.now() + 3 * 60_000 + 1_000, limit: 50 })
    expect((await runRow(lonelyRun.id)).error).toEqual({
      code: "runner_unavailable", message: "Missed — no connected desktop has this Automation's workspace.", retryable: false,
    })
    expect((await runRow(unpinnedRun.id)).error?.message).toBe("Missed — the connected desktop did not pick this up in time.")
  })

  test("a Desktop Automation runs once in the cloud without changing where it runs", async () => {
    const report = await desktopAutomation("Desktop digest", scopeA, "ws_laptop")
    const run = await automations.runNow(scopeA, report.automation.id, { executionTarget: "cloud" })
    if (!run) throw new Error("expected a run")
    expect(run.executionTarget).toBe("cloud")
    const finished = await settled(run.id)
    expect(finished.status).toBe("succeeded")
    expect(finished.execution_target).toBe("cloud")
    expect(finished.engine_kind).toBe(HEADLESS)
    expect(finished.result_summary).toBe("Two launch decisions landed overnight.")
    expect(headless.prompts).toContain("Run Desktop digest")
    // No desktop is woken for it, and the Automation itself still runs on the desktops.
    const notified = await db.select().from(AutomationRunnerNotificationTable).where(eq(AutomationRunnerNotificationTable.run_id, run.id))
    expect(notified).toEqual([])
    const current = await automations.get(scopeA, report.automation.id)
    expect(current?.revision).toMatchObject({ executionTarget: "desktop", workspaceId: "ws_laptop", version: 1 })

    // The reverse, by the owner: a Cloud Automation once on a desktop, unpinned.
    const cloud = await cloudAutomation("Cloud digest")
    await automations.update(scopeA, cloud.automation.id, { workspaceId: "ws_cloud_computer" })
    const onDesktop = await automations.runNow(scopeA, cloud.automation.id, { executionTarget: "desktop" })
    if (!onDesktop) throw new Error("expected a run")
    expect(onDesktop).toMatchObject({ executionTarget: "desktop", status: "queued" })
    const work = await automations.discoverDesktopRunnerWork({ ...scopeA, runnerId: install, capabilities: [] })
    // The cloud computer's workspace does not exist on a desktop, so the run is not pinned.
    expect(work).toContainEqual({ runId: onDesktop.id, executionTarget: "desktop" })
    await automations.cancelRun(scopeA, onDesktop.id)
  })

  test("a failed one-off cloud run never pauses the Desktop Automation's own schedule", async () => {
    serviceModule.configureHeadlessAgentExecutor(async () => ({
      ok: false, status: "failed", code: "provider_unavailable", retryable: false, needsAttention: true,
      message: "The cloud model is not available. An admin needs to check the headless runner's model access.",
    }))
    try {
      const report = await desktopAutomation("Try it in the cloud", scopeA, null)
      const run = await automations.runNow(scopeA, report.automation.id, { executionTarget: "cloud" })
      if (!run) throw new Error("expected a run")
      const finished = await settled(run.id)
      expect(finished.status).toBe("failed")
      expect(finished.error?.code).toBe("provider_unavailable")
      const current = await automations.get(scopeA, report.automation.id)
      expect(current?.automation.state).toBe("active")
      expect(current?.automation.needsAttentionReason).toBeNull()
      expect(current?.automation.nextDueAt).not.toBeNull()
    } finally {
      useAnsweringRunner()
    }
  })

  test("an Automation moves between desktop and cloud as a new revision; Workflows and agents stay in the cloud", async () => {
    const report = await desktopAutomation("Movable report", scopeA, "ws_laptop")
    const toCloud = await automations.update(scopeA, report.automation.id, { executionTarget: "cloud" })
    // The desktop folder does not follow it to the cloud.
    expect(toCloud?.revision).toMatchObject({ executionTarget: "cloud", workspaceId: null, version: 2 })
    await expect(automations.update(scopeA, report.automation.id, { executionTarget: "desktop" }, { agentCaller: true }))
      .rejects.toThrow("automation_agent_desktop_placement")
    const back = await automations.update(scopeA, report.automation.id, { executionTarget: "desktop", workspaceId: "ws_desk" })
    expect(back?.revision).toMatchObject({ executionTarget: "desktop", workspaceId: "ws_desk", version: 3 })

    const saved = await cloudAutomation("Pinned Workflow", {
      kind: "saved_script",
      script: { pluginId: "plg_fixture", configObjectId: "cob_fixture", configObjectVersionId: "cov_fixture" },
    })
    await expect(automations.update(scopeA, saved.automation.id, { executionTarget: "desktop" }))
      .rejects.toThrow("automation_action_target_mismatch")
    await expect(automations.runNow(scopeA, saved.automation.id, { executionTarget: "desktop" }))
      .rejects.toThrow("automation_action_target_mismatch")
  })

  test("over HTTP, agents may run work only in the cloud and bad run bodies are refused", async () => {
    const request = routedApp()
    const cloud = await cloudAutomation("Agent-managed digest")
    const desktop = await desktopAutomation("Agent-visible desktop digest", scopeA, null)

    const onDesktop = await request(`/v1/automations/${cloud.automation.id}/run`, { method: "POST", agent: true, body: { executionTarget: "desktop" } })
    expect(onDesktop.status).toBe(400)
    expect(await onDesktop.json()).toMatchObject({ error: "automation_agent_desktop_placement" })
    const moved = await request(`/v1/automations/${cloud.automation.id}`, { method: "PATCH", agent: true, body: { executionTarget: "desktop" } })
    expect(moved.status).toBe(400)
    expect(await moved.json()).toMatchObject({ error: "automation_agent_desktop_placement" })

    expect((await request(`/v1/automations/${desktop.automation.id}/run`, { method: "POST", body: { executionTarget: "sandbox" } })).status).toBe(400)
    expect((await request(`/v1/automations/${desktop.automation.id}/run`, { method: "POST", rawBody: "{" })).status).toBe(400)

    // An agent may run a Desktop Automation once in the cloud.
    const inCloud = await request(`/v1/automations/${desktop.automation.id}/run`, { method: "POST", agent: true, body: { executionTarget: "cloud" } })
    expect(inCloud.status).toBe(202)
    const { run } = await inCloud.json()
    expect(run.executionTarget).toBe("cloud")
    expect((await settled(run.id)).status).toBe("succeeded")

    // A released client's plain run, with no body at all, still runs where the Automation runs.
    const plain = await request(`/v1/automations/${desktop.automation.id}/run`, { method: "POST" })
    expect(plain.status).toBe(202)
    const queued = (await plain.json()).run
    expect(queued.executionTarget).toBe("desktop")
    await automations.cancelRun(scopeA, queued.id)
  })
})
