import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { AutomationListItem } from "@openwork/automations"
import {
  AUTOMATION_RUNNER_WORK_RUN_LIMIT,
  automationExecutionTargetListSchema,
  automationRunnerWorkResponseSchema,
  runAutomationNowSchema,
  updateAutomationSchema,
  type AutomationAction,
  type AutomationExecutionTarget,
} from "@openwork/types/automations"
import { buildMcpCatalog } from "../src/mcp/catalog.js"
import { isMcpOperationAllowed } from "../src/mcp/policy.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type ServiceModule = typeof import("../src/automations/service.js")
type RepositoryModule = typeof import("../src/automations/repository.js")
let service: ServiceModule
let repository: RepositoryModule
const spies: Array<{ mockRestore(): void }> = []

beforeAll(async () => {
  seedRequiredEnv()
  service = await import("../src/automations/service.js")
  repository = await import("../src/automations/repository.js")
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const scope = { organizationId, ownerMemberId, modelAttentionCapable: true }
const agentModel = { providerId: "opencode", modelId: "big-pickle", variant: null }

/** Inactive, so loading it never revalidates model access against a database. */
function automation(target: AutomationExecutionTarget, action: AutomationAction): AutomationListItem {
  const now = Date.now()
  return {
    automation: {
      id: createDenTypeId("automation"), organizationId, ownerMemberId, name: "Morning brief", state: "inactive",
      currentRevisionId: createDenTypeId("automationRevision"), nextDueAt: null, latestRunAt: null,
      needsAttentionReason: null, createdAt: now, updatedAt: now, archivedAt: null,
    },
    revision: {
      id: createDenTypeId("automationRevision"), automationId: createDenTypeId("automation"), version: 1,
      instructions: "Summarize overnight changes.", schedule: { kind: "daily", timezone: "UTC", hour: 8, minute: 0 },
      model: agentModel, action, executionTarget: target, workspaceId: target === "desktop" ? "ws_laptop" : null,
      maximumRuntimeMs: 900_000, digest: "0123456789abcdef", createdAt: now,
    },
    latestRun: null,
  }
}
const agent: AutomationAction = { kind: "agent", instructions: "Summarize overnight changes.", model: agentModel }
const workflow: AutomationAction = {
  kind: "saved_script",
  script: { pluginId: "plg_fixture", configObjectId: "cob_fixture", configObjectVersionId: "cov_fixture" },
}

/** Loads `item`, and fails the test if anything would dispatch or persist work. */
function stubRepository(item: AutomationListItem) {
  const { automationRepository } = repository
  const refused = (method: string) => async () => {
    throw new Error(`${method} must not run for a refused placement`)
  }
  spies.push(
    spyOn(automationRepository, "get").mockResolvedValue(item),
    spyOn(automationRepository, "claim").mockImplementation(refused("claim")),
    spyOn(automationRepository, "recordSkippedManual").mockImplementation(refused("recordSkippedManual")),
    spyOn(automationRepository, "update").mockImplementation(refused("update")),
    spyOn(automationRepository, "markNeedsAttention").mockImplementation(refused("markNeedsAttention")),
  )
}

describe("runner identity and routing", () => {
  test("runner rows are keyed per organization, member, and install, within the id column", () => {
    const install = "2f6c1d0e-6b3e-4d7f-9a51-0c8f5e7b2a10"
    const otherOrganization = createDenTypeId("organization")
    const otherMember = createDenTypeId("member")
    const row = repository.automationRunnerRowId({ organizationId, ownerMemberId, runnerId: install })
    expect(row).toBe(repository.automationRunnerRowId({ organizationId, ownerMemberId, runnerId: install }))
    expect(row).not.toBe(install)
    expect(row.length).toBeLessThanOrEqual(160)
    expect(repository.automationRunnerRowId({ organizationId: otherOrganization, ownerMemberId: otherMember, runnerId: install })).not.toBe(row)
    expect(repository.automationRunnerRowId({ organizationId, ownerMemberId, runnerId: `${install}-2` })).not.toBe(row)
  })

  test("a workspace pin applies only on the revision's own target", () => {
    expect(repository.runWorkspaceId({ executionTarget: "desktop", workspaceId: "ws_laptop" }, "desktop")).toBe("ws_laptop")
    expect(repository.runWorkspaceId({ executionTarget: undefined, workspaceId: "ws_laptop" }, "desktop")).toBe("ws_laptop")
    // A desktop folder does not exist on a cloud computer, nor the reverse.
    expect(repository.runWorkspaceId({ executionTarget: "desktop", workspaceId: "ws_laptop" }, "cloud")).toBeNull()
    expect(repository.runWorkspaceId({ executionTarget: "cloud", workspaceId: "ws_cloud" }, "desktop")).toBeNull()
    expect(repository.runWorkspaceId({ executionTarget: "desktop", workspaceId: null }, "desktop")).toBeNull()
  })

  test("work items stay the released two-field shape unless the run is pinned", () => {
    const parsed = automationRunnerWorkResponseSchema.parse({
      items: [
        { runId: "arun_1", executionTarget: "desktop" },
        { runId: "arun_2", executionTarget: "desktop", workspaceId: "ws_laptop" },
        { kind: "remote_session_create", commandId: "rsc_1" },
      ],
    })
    expect(parsed.items[0]).toEqual({ runId: "arun_1", executionTarget: "desktop" })
    expect(parsed.items[1]).toEqual({ runId: "arun_2", executionTarget: "desktop", workspaceId: "ws_laptop" })
    // Room for the run limit plus five remote-session commands and five remote-session requests.
    const full = Array.from({ length: AUTOMATION_RUNNER_WORK_RUN_LIMIT + 10 }, (_, index) => ({ runId: `arun_${index}`, executionTarget: "desktop" }))
    expect(automationRunnerWorkResponseSchema.safeParse({ items: full }).success).toBe(true)
    expect(automationRunnerWorkResponseSchema.safeParse({ items: [...full, full[0]] }).success).toBe(false)
  })

  test("execution targets list desktops and one Cloud entry", () => {
    expect(automationExecutionTargetListSchema.parse({
      items: [
        { kind: "desktop", id: "rnr_1", platform: "darwin", appVersion: "0.19.0", lastSeenAt: 1, connected: true },
        { kind: "cloud", available: false, runtime: null, cloudComputer: false },
      ],
    }).items).toHaveLength(2)
    expect(automationExecutionTargetListSchema.safeParse({ items: [{ kind: "cloud", available: true, runtime: "vm" }] }).success).toBe(false)
  })

  test("a run may name its target once; an Automation may change its target", () => {
    expect(runAutomationNowSchema.parse({})).toEqual({})
    expect(runAutomationNowSchema.parse({ executionTarget: "cloud" })).toEqual({ executionTarget: "cloud" })
    expect(runAutomationNowSchema.safeParse({ executionTarget: "sandbox" }).success).toBe(false)
    expect(updateAutomationSchema.parse({ executionTarget: "desktop" })).toEqual({ executionTarget: "desktop" })
  })
})

describe("placement rules", () => {
  test("agents never put work on the desktop: no run-once there, no move there", async () => {
    const cloud = automation("cloud", agent)
    stubRepository(cloud)
    const automations = new service.AutomationService({ cloudRuntime: async () => "headless" })
    await expect(automations.runNow(scope, cloud.automation.id, { executionTarget: "desktop", agentCaller: true }))
      .rejects.toThrow("automation_agent_desktop_placement")
    await expect(automations.update(scope, cloud.automation.id, { executionTarget: "desktop" }, { agentCaller: true }))
      .rejects.toThrow("automation_agent_desktop_placement")
  })

  test("a Workflow never runs on the desktop, once or for good", async () => {
    const saved = automation("cloud", workflow)
    stubRepository(saved)
    const automations = new service.AutomationService({ cloudRuntime: async () => "headless" })
    await expect(automations.runNow(scope, saved.automation.id, { executionTarget: "desktop" }))
      .rejects.toThrow("automation_action_target_mismatch")
    await expect(automations.update(scope, saved.automation.id, { executionTarget: "desktop" }))
      .rejects.toThrow("automation_action_target_mismatch")
  })

  test("running once or moving to the cloud needs the access cloud creation needs", async () => {
    const desktop = automation("desktop", agent)
    stubRepository(desktop)
    const withoutWeb = new service.AutomationService({
      cloudRuntime: async () => "web",
      getOpenWorkWebAccess: async () => ({ hasAccess: false }),
    })
    await expect(withoutWeb.runNow(scope, desktop.automation.id, { executionTarget: "cloud" }))
      .rejects.toMatchObject({ code: "openwork_web_access_required" })
    await expect(withoutWeb.update(scope, desktop.automation.id, { executionTarget: "cloud" }))
      .rejects.toMatchObject({ code: "openwork_web_access_required" })

    service.configureCloudAgentExecutor({
      execute: async () => { throw new Error("must not execute") },
      runtimeAvailable: async () => false,
    })
    const withoutComputer = new service.AutomationService({
      cloudRuntime: async () => "web",
      getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    })
    await expect(withoutComputer.runNow(scope, desktop.automation.id, { executionTarget: "cloud" }))
      .rejects.toThrow("automation_cloud_worker_required")
    await expect(withoutComputer.update(scope, desktop.automation.id, { executionTarget: "cloud" }))
      .rejects.toThrow("automation_cloud_worker_required")
  })
})

describe("MCP surface", () => {
  const routesSource = readFileSync(join(import.meta.dir, "../src/routes/automations/index.ts"), "utf8")
  const snapshot: Parameters<typeof buildMcpCatalog>[0] = JSON.parse(readFileSync(join(import.meta.dir, "../../../../packages/docs/openapi.json"), "utf8"))
  const catalog = buildMcpCatalog(snapshot)

  test("the target list is for OpenWork surfaces, not an agent tool", () => {
    expect(routesSource).toContain('operationId: "listAutomationRunners", "x-mcp": false')
    expect(isMcpOperationAllowed({
      method: "GET",
      path: "/v1/automation-runners",
      operation: { operationId: "listAutomationRunners", tags: ["Automations"], "x-mcp": false },
    })).toBe(false)
    expect(catalog.some((tool) => tool.operation.operationId === "listAutomationRunners")).toBe(false)
  })

  test("running now stays an agent tool whose body is optional, so existing calls keep working", () => {
    const tool = catalog.find((entry) => entry.operation.operationId === "runAutomationNow")
    expect(tool).toBeDefined()
    expect(tool?.inputSchema.safeParse({ path: { id: "aut_fixture" } }).success).toBe(true)
    expect(tool?.inputSchema.safeParse({ path: { id: "aut_fixture" }, body: { executionTarget: "cloud" } }).success).toBe(true)
    // The agent rule is enforced by Den for the internal MCP session, not by the schema.
    expect(routesSource).toContain('agentCaller: c.get("session")?.id === "mcp_internal"')
  })
})
