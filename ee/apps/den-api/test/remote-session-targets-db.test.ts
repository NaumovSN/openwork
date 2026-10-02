import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  AutomationRunnerTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { RemoteSessionCommandTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import {
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  automationDesktopRunnerRegistrationSchema,
  type DesktopRunnerInventory,
} from "@openwork/types/automations"
import type { OrganizationContextVariables } from "../src/middleware/index.js"

// Only opt into an explicitly isolated database, never a developer's regular Den.
const databaseUrl = process.env.DEN_AUTOMATION_RUNNERS_TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
if (databaseUrl && !new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("Remote-session target DB tests require an isolated *_test database")
process.env.DATABASE_URL = databaseUrl ?? "mysql://root:password@127.0.0.1:3306/openwork_automation_runners_test"
process.env.DEN_DB_ENCRYPTION_KEY = "automation-runners-test-encryption-key-00"
process.env.BETTER_AUTH_SECRET = "automation-runners-test-auth-secret-0000"
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
process.env.CORS_ORIGINS = "http://127.0.0.1:8790"

const INVENTORY: DesktopRunnerInventory = {
  computer: { label: "Work Laptop", platform: "darwin", appVersion: "0.19.0" },
  workspaces: [{
    workspaceId: "ws_repo",
    name: "Repo",
    active: true,
    engine: "v1",
    defaultModel: { providerId: "anthropic", modelId: "claude-sonnet" },
    models: [{ providerId: "anthropic", modelId: "claude-sonnet", name: "Claude Sonnet" }],
  }],
}

suite("remote-session targets: real database", () => {
  let db: (typeof import("../src/db.js"))["db"]
  let repository: typeof import("../src/automations/repository.js")
  let capabilities: typeof import("../src/mcp/remote-session-capabilities.js")
  let runnerAuth: (typeof import("../src/automations/runner-auth.js"))["automationRunnerAuth"]
  let env: (typeof import("../src/env.js"))["env"]
  let automations: InstanceType<(typeof import("../src/automations/service.js"))["AutomationService"]>
  let app: Hono<{ Variables: Partial<OrganizationContextVariables> }>
  const userId = createDenTypeId("user")
  const organizationId = createDenTypeId("organization")
  const ownerMemberId = createDenTypeId("member")
  const scope = { organizationId, ownerMemberId }
  const laptop = `laptop-${randomUUID()}`
  const studio = `studio-${randomUUID()}`
  const commandIds: DenTypeId<"remoteSessionCommand">[] = []
  const commandIdOf = (value: unknown) => normalizeDenTypeId("remoteSessionCommand", String(value))
  let previousRuntimeEnabled = false

  const tokenFor = (runnerId: string) => runnerAuth.issue({
    organizationId,
    ownerMemberId,
    runnerId,
    capabilities: [REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY],
  }, "http://den.local").token

  const runnerRequest = (runnerId: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(`http://den.local${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${tokenFor(runnerId)}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })

  const execute = (action: "targets" | "create" | "read", body: unknown) =>
    capabilities.executeRemoteSessionCapability({ action, organizationId, userId, hasWriteScope: true, body }, {
      ...capabilities.DEFAULT_REMOTE_SESSION_DEPS,
      getOpenWorkWebAccess: async () => ({ hasAccess: true }),
      cloudAvailable: () => false,
    })

  beforeAll(async () => {
    db = (await import("../src/db.js")).db
    repository = await import("../src/automations/repository.js")
    capabilities = await import("../src/mcp/remote-session-capabilities.js")
    runnerAuth = (await import("../src/automations/runner-auth.js")).automationRunnerAuth
    env = (await import("../src/env.js")).env
    previousRuntimeEnabled = env.automations.runtimeEnabled
    env.automations.runtimeEnabled = true
    const { AutomationService } = await import("../src/automations/service.js")
    const { registerAutomationRoutes } = await import("../src/routes/automations/index.js")
    automations = new AutomationService({ cloudRuntime: async () => "headless", getOpenWorkWebAccess: async () => ({ hasAccess: true }) })
    app = new Hono<{ Variables: Partial<OrganizationContextVariables> }>()
    registerAutomationRoutes(app, { service: automations })
    await db.insert(AuthUserTable).values({ id: userId, name: "Owner", email: `${userId}@example.test` })
    await db.insert(OrganizationTable).values({ id: organizationId, name: "Remote-session targets test", slug: organizationId })
    await db.insert(MemberTable).values({ id: ownerMemberId, organizationId, userId, role: "member" })
    for (const runnerId of [laptop, studio]) {
      await automations.registerDesktopRunner(scope, automationDesktopRunnerRegistrationSchema.parse({
        runnerId,
        protocolVersion: 1,
        supportedExecutionTargets: ["desktop"],
        capabilities: [REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY],
        appVersion: "0.19.0",
        platform: runnerId === laptop ? "darwin" : "win32",
        concurrency: 1,
      }))
    }
  })

  afterAll(async () => {
    if (!db) return
    env.automations.runtimeEnabled = previousRuntimeEnabled
    if (commandIds.length) await db.delete(RemoteSessionCommandTable).where(inArray(RemoteSessionCommandTable.id, commandIds))
    await db.delete(AutomationRunnerTable).where(eq(AutomationRunnerTable.organization_id, organizationId))
    await db.delete(MemberTable).where(eq(MemberTable.id, ownerMemberId))
    await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
    await db.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
  })

  test("a desktop's inventory is stored and listed by remote-session:targets", async () => {
    const stored = await runnerRequest(laptop, "/v1/automation-runner/inventory", { method: "PUT", body: { ...INVENTORY, futureField: true } })
    expect(stored.status).toBe(200)
    expect(await stored.json()).toMatchObject({ ok: true })
    const invalid = await runnerRequest(laptop, "/v1/automation-runner/inventory", {
      method: "PUT",
      body: { ...INVENTORY, workspaces: Array.from({ length: 51 }, () => INVENTORY.workspaces[0]) },
    })
    expect(invalid.status).toBe(400)
    const unregistered = await runnerRequest(`ghost-${randomUUID()}`, "/v1/automation-runner/inventory", { method: "PUT", body: INVENTORY })
    expect(unregistered.status).toBe(404)

    const listed = (await execute("targets", { includeModels: true })).structuredContent
    const laptopId = repository.automationRunnerRowId({ ...scope, runnerId: laptop })
    const studioId = repository.automationRunnerRowId({ ...scope, runnerId: studio })
    expect(listed?.cloud).toEqual({ available: false })
    expect(listed?.computers).toEqual(expect.arrayContaining([
      expect.objectContaining({ computerId: laptopId, label: "Work Laptop", online: true, workspaces: [expect.objectContaining({ workspaceId: "ws_repo", models: INVENTORY.workspaces[0]?.models })] }),
      expect.objectContaining({ computerId: studioId, label: "Windows PC", online: true, workspaces: null }),
    ]))
  })

  test("a pinned command is offered to and claimable by only its computer, with its workspace", async () => {
    const laptopId = repository.automationRunnerRowId({ ...scope, runnerId: laptop })
    const created = (await execute("create", {
      target: "desktop",
      prompt: "Summarize the notes",
      computerId: laptopId,
      workspaceId: "ws_repo",
      model: { providerId: "anthropic", modelId: "claude-sonnet" },
    })).structuredContent
    expect(created).toMatchObject({ state: "queued", computerId: laptopId, workspaceId: "ws_repo" })
    const commandId = commandIdOf(created?.commandId)
    commandIds.push(commandId)
    const [row] = await db.select().from(RemoteSessionCommandTable).where(eq(RemoteSessionCommandTable.id, commandId))
    expect(row).toMatchObject({ target_computer_id: laptopId, target_workspace_id: "ws_repo" })

    const untargeted = (await execute("create", { target: "desktop", prompt: "Anywhere" })).structuredContent
    const untargetedId = commandIdOf(untargeted?.commandId)
    commandIds.push(untargetedId)

    const workFor = async (runnerId: string) => {
      const response = await runnerRequest(runnerId, "/v1/automation-runner/work")
      const body: { items: Array<{ commandId?: string }> } = await response.json()
      return body.items.flatMap((item) => (item.commandId ? [item.commandId] : []))
    }
    expect(await workFor(studio)).toEqual([untargetedId])
    expect(await workFor(laptop)).toEqual([commandId, untargetedId])

    const stolen = await runnerRequest(studio, `/v1/remote-session-commands/${commandId}/claim`, { method: "POST", body: {} })
    expect(stolen.status).toBe(409)
    const claimed = await runnerRequest(laptop, `/v1/remote-session-commands/${commandId}/claim`, { method: "POST", body: {} })
    expect(claimed.status).toBe(200)
    expect((await claimed.json()).assignment).toMatchObject({ commandId, workspaceId: "ws_repo" })
    const plain = await runnerRequest(studio, `/v1/remote-session-commands/${untargetedId}/claim`, { method: "POST", body: {} })
    expect((await plain.json()).assignment).not.toHaveProperty("workspaceId")

    expect((await execute("read", { commandId })).structuredContent).toMatchObject({ state: "claimed", computerId: laptopId })
  })
})
