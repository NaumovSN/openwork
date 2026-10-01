import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  AutomationRevisionTable,
  AutomationRunEventTable,
  AutomationRunTable,
  AutomationTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createAutomationSchema } from "@openwork/types/automations"
import { createHeadlessRunnerClient } from "../src/headless-runner/client.js"

// Only opt into an explicitly isolated database, never a developer's regular Den.
const databaseUrl = process.env.DEN_HEADLESS_AUTOMATIONS_TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
if (databaseUrl && !new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("Headless Automation DB tests require an isolated *_test database")
process.env.DATABASE_URL = databaseUrl ?? "mysql://root:password@127.0.0.1:3306/openwork_headless_automations_test"
process.env.DEN_DB_ENCRYPTION_KEY = "headless-automations-test-encryption-key-0"
process.env.BETTER_AUTH_SECRET = "headless-automations-test-auth-secret-000"
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
process.env.CORS_ORIGINS = "http://127.0.0.1:8790"
// One OpenWork Web slot and two headless slots make the pool boundary observable.
process.env.DEN_AUTOMATIONS_MAX_CONCURRENCY = "1"
process.env.DEN_HEADLESS_AUTOMATIONS_MAX_CONCURRENCY = "2"

const HEADLESS = "openwork-headless-agent-v1"

/** The smallest runner that answers every turn: one assistant reply, then completed. */
function answeringRunner(answer: string) {
  let sessions = 0
  const turns = new Map<string, number>()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.pathname === "/v1/models") return json(200, { defaultModel: "gwm_default", models: [{ id: "gwm_default", name: "Default" }] })
    if (url.pathname === "/v1/sessions") return json(201, { id: `hs_db_${++sessions}` })
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname.endsWith("/turns")) {
      turns.set(String(body.messageId), 0)
      return json(202, { state: "accepted" })
    }
    const messageId = url.searchParams.get("messageId") ?? ""
    const reads = (turns.get(messageId) ?? 0) + 1
    turns.set(messageId, reads)
    const done = reads > 1
    return json(200, {
      turns: [{ messageId, status: done ? "completed" : "running", error: null, model: "gwm_default", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } }],
      messages: done ? [{ messageId, role: "user", text: "go" }, { messageId, role: "assistant", text: answer, toolCalls: [] }] : [],
      finalAssistantText: done ? answer : "",
    })
  }
  return createHeadlessRunnerClient({
    config: { url: "http://headless-runner:8795", token: "t".repeat(40) },
    fetch: fetchImpl,
    mintToken: async () => ({ token: "ow_mcp_at_test" }),
  })
}

suite("headless Automations: real database", () => {
  let db: (typeof import("../src/db.js"))["db"]
  let repository: (typeof import("../src/automations/repository.js"))["automationRepository"]
  let service: typeof import("../src/automations/service.js")
  let executor: typeof import("../src/automations/headless-agent-executor.js")
  const orgId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const automationIds: string[] = []

  beforeAll(async () => {
    db = (await import("../src/db.js")).db
    repository = (await import("../src/automations/repository.js")).automationRepository
    service = await import("../src/automations/service.js")
    executor = await import("../src/automations/headless-agent-executor.js")
    await db.insert(OrganizationTable).values({
      id: orgId,
      name: "Headless Automations test",
      slug: orgId,
      // Team plan, headless switch on, and deliberately no OpenWork Web access.
      metadata: { plan: { tier: "team" }, capabilities: { headlessAutomations: true } },
    })
    await db.insert(AuthUserTable).values({ id: userId, name: "Owner", email: `${userId}@example.test` })
    await db.insert(MemberTable).values({ id: memberId, organizationId: orgId, userId, role: "member" })
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
    await db.delete(MemberTable).where(eq(MemberTable.id, memberId))
    await db.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
    await db.delete(OrganizationTable).where(eq(OrganizationTable.id, orgId))
  })

  async function queuedCloudRun(name: string) {
    const created = await repository.create({
      organizationId: orgId,
      ownerMemberId: memberId,
      now: Date.now(),
      definition: createAutomationSchema.parse({
        name,
        schedule: { kind: "daily", timezone: "UTC", hour: 8, minute: 0 },
        action: { kind: "agent", instructions: `Run ${name}`, model: { providerId: "ipr_test", modelId: "gwm_default" } },
        executionTarget: "cloud",
      }),
    })
    automationIds.push(created.automation.id)
    const claim = await repository.claim({
      automation: created.automation,
      revision: created.revision,
      trigger: "manual",
      scheduledFor: null,
      nonce: randomUUID(),
      leaseOwner: "test",
      leaseMs: 60_000,
      claimDeadlineMs: 180_000,
      now: Date.now(),
    })
    if (claim.kind !== "claimed") throw new Error("expected a queued run")
    return claim.run.id
  }

  async function settled(runId: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [run] = await db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, runId)).limit(1)
      if (run && ["succeeded", "failed", "cancelled", "skipped"].includes(run.status)) return run
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("run did not settle")
  }

  test("a Team organization without Web seats runs a cloud agent Automation on the runner", async () => {
    const client = answeringRunner("You missed two launch decisions.")
    service.configureHeadlessAgentExecutor((input) => executor.executeHeadlessAgent(input, {
      client,
      ownerUserId: async () => userId,
      stillHeadless: async () => true,
      sleep: async () => {},
      pollIntervalMs: 0,
    }))
    const automations = new service.AutomationService({
      cloudRuntime: async () => "headless",
      getOpenWorkWebAccess: async () => ({ hasAccess: false }),
    })
    const runId = await queuedCloudRun("Launch digest")
    await automations.tick()
    const run = await settled(runId)
    expect(run.status).toBe("succeeded")
    expect(run.engine_kind).toBe(HEADLESS)
    expect(run.result_summary).toBe("You missed two launch decisions.")
    expect(run.engine_receipt).toMatchObject({ runtime: "headless", sessionId: "hs_db_1" })
    const events = await db.select().from(AutomationRunEventTable).where(eq(AutomationRunEventTable.run_id, runId))
    expect(events.sort((left, right) => left.sequence - right.sequence).map((event) => event.event_type)).toEqual(["user", "assistant", "usage", "terminal"])
  })

  test("headless runs have their own pool and never take or wait for OpenWork Web slots", async () => {
    const now = Date.now()
    const busyWeb = await queuedCloudRun("Busy Web run")
    await db.update(AutomationRunTable).set({ status: "running", engine_kind: "openwork-cloud-agent-v1", lease_expires_at: new Date(now + 60_000) })
      .where(eq(AutomationRunTable.id, busyWeb))

    // The single Web slot is taken, yet a headless run is admitted.
    const first = await queuedCloudRun("Headless 1")
    expect(await repository.claimCloud({ runId: first, leaseOwner: "a", leaseMs: 60_000, maxConcurrency: 2, engineKind: HEADLESS, headlessEngineKind: HEADLESS, now })).not.toBeNull()
    const second = await queuedCloudRun("Headless 2")
    expect(await repository.claimCloud({ runId: second, leaseOwner: "b", leaseMs: 60_000, maxConcurrency: 2, engineKind: HEADLESS, headlessEngineKind: HEADLESS, now })).not.toBeNull()

    // Two headless runs fill the headless pool; the third waits, queued.
    const third = await queuedCloudRun("Headless 3")
    expect(await repository.claimCloud({ runId: third, leaseOwner: "c", leaseMs: 60_000, maxConcurrency: 2, engineKind: HEADLESS, headlessEngineKind: HEADLESS, now })).toBeNull()

    // And headless work never counts against the Web pool: only the Web run does.
    const web = await queuedCloudRun("Web 2")
    expect(await repository.claimCloud({ runId: web, leaseOwner: "d", leaseMs: 60_000, maxConcurrency: 1, engineKind: "openwork-cloud-agent-v1", headlessEngineKind: HEADLESS, now })).toBeNull()
    await db.update(AutomationRunTable).set({ status: "succeeded" }).where(eq(AutomationRunTable.id, busyWeb))
    expect(await repository.claimCloud({ runId: web, leaseOwner: "d", leaseMs: 60_000, maxConcurrency: 1, engineKind: "openwork-cloud-agent-v1", headlessEngineKind: HEADLESS, now })).not.toBeNull()

    const [queued] = await db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, third)).limit(1)
    expect(queued?.status).toBe("queued")
    await db.update(AutomationRunTable).set({ status: "cancelled" }).where(inArray(AutomationRunTable.id, [first, second, third, web]))
  })
})
