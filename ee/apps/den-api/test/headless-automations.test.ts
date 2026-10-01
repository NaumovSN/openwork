import "./headless-test-env.js"
import { describe, expect, test } from "bun:test"
import type { CloudAgentExecutorInput } from "../src/automations/cloud-agent-executor.js"
import {
  executeHeadlessAgent,
  headlessMessageIdForRun,
  HEADLESS_AUTOMATION_INSTRUCTIONS,
  parseHeadlessReceipt,
  type HeadlessAgentExecutorDeps,
} from "../src/automations/headless-agent-executor.js"
import { cloudAutomationRuntimeForOrganization } from "../src/automations/headless-runtime.js"
import { resolveAutomationModelAccessWithStore, type AutomationModelAuthorityStore } from "../src/automations/authority.js"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
import { createHeadlessRunnerClient } from "../src/headless-runner/client.js"

const TOKEN = "t".repeat(40)
const runnerEnv = { DEN_HEADLESS_RUNNER_URL: "http://headless-runner:8795", DEN_HEADLESS_RUNNER_TOKEN: TOKEN }

describe("where cloud Automations run", () => {
  const enabled = { capabilities: { headlessAutomations: true }, plan: { tier: "team" } }

  test("headless needs the switch, a Team or Enterprise plan, and a configured runner", () => {
    expect(cloudAutomationRuntimeForOrganization(enabled, { env: runnerEnv, gatingEnabled: true })).toBe("headless")
    expect(cloudAutomationRuntimeForOrganization(JSON.stringify(enabled), { env: runnerEnv, gatingEnabled: true })).toBe("headless")
    expect(cloudAutomationRuntimeForOrganization({ ...enabled, plan: { tier: "enterprise" } }, { env: runnerEnv, gatingEnabled: true })).toBe("headless")
    expect(cloudAutomationRuntimeForOrganization({ ...enabled, plan: { tier: "free" } }, { env: runnerEnv, gatingEnabled: true })).toBe("web")
    expect(cloudAutomationRuntimeForOrganization({ plan: { tier: "team" } }, { env: runnerEnv, gatingEnabled: true })).toBe("web")
    expect(cloudAutomationRuntimeForOrganization(enabled, { env: {}, gatingEnabled: true })).toBe("web")
    expect(cloudAutomationRuntimeForOrganization(null, { env: runnerEnv })).toBe("web")
  })

  test("without plan gating (self-hosted), the switch and a runner are enough", () => {
    expect(cloudAutomationRuntimeForOrganization({ capabilities: { headlessAutomations: true } }, { env: runnerEnv, gatingEnabled: false })).toBe("headless")
  })
})

type Turn = { status: string; error: string | null; model: string | null; prompt: string; reads: string[] }

/** An in-memory headless runner speaking the real HTTP contract. */
function fakeRunner(options: { reads?: string[]; final?: string; error?: string; models?: string[]; createStatus?: number } = {}) {
  const sessions = new Map<string, { title?: string; instructions?: string }>()
  const turns = new Map<string, Turn>()
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = []
  const minted: Array<{ ttlMs?: number; userId: string }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body })
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status })
    if (url.pathname === "/v1/models") {
      const ids = options.models ?? ["gwm_default"]
      return json(200, { defaultModel: ids[0], models: ids.map((id) => ({ id, name: id })) })
    }
    if (url.pathname === "/v1/sessions" && init?.method === "POST") {
      if (options.createStatus) return json(options.createStatus, { error: "unavailable" })
      const id = `hs_${sessions.size + 1}`
      sessions.set(id, body ?? {})
      return json(201, { id })
    }
    const match = /^\/v1\/sessions\/([^/]+)(\/turns|\/abort)?$/.exec(url.pathname)
    if (!match || !sessions.has(match[1])) return json(404, { error: "unknown_session" })
    const sessionId = match[1]
    if (match[2] === "/turns") {
      const key = `${sessionId}:${body.messageId}`
      const existing = turns.get(key)
      if (existing && !["failed", "interrupted"].includes(existing.status)) return json(202, { state: "already_present" })
      if (existing) {
        existing.status = "queued"
        return json(202, { state: "resumed" })
      }
      turns.set(key, { status: "queued", error: null, model: body.model ?? "gwm_default", prompt: body.prompt, reads: [...(options.reads ?? ["running", "completed"])] })
      return json(202, { state: "accepted" })
    }
    if (match[2] === "/abort") {
      const key = `${sessionId}:${body?.messageId}`
      const turn = turns.get(key)
      if (!turn || !["queued", "running"].includes(turn.status)) return json(200, { accepted: false })
      turn.status = "aborted"
      turn.reads = []
      return json(200, { accepted: true })
    }
    const messageId = url.searchParams.get("messageId") ?? ""
    const turn = turns.get(`${sessionId}:${messageId}`)
    if (turn && turn.reads.length) {
      turn.status = turn.reads.shift() ?? turn.status
      if (turn.status === "failed") turn.error = options.error ?? "model_http_500"
    }
    const done = turn?.status === "completed"
    return json(200, {
      turns: turn ? [{ messageId, status: turn.status, error: turn.error, model: turn.model, usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 90 } }] : [],
      messages: turn
        ? [
            { seq: 1, messageId, role: "user", text: turn.prompt },
            { seq: 2, messageId, role: "assistant", text: "Checking #launch.", toolCalls: [{ id: "c1", name: "execute_capability", input: { name: "mcp:emc_1:slack_search" } }] },
            { seq: 3, messageId, role: "tool", callId: "c1", name: "execute_capability", output: "4 messages", isError: false },
            ...(done ? [{ seq: 4, messageId, role: "assistant", text: options.final ?? "You missed 2 launch decisions.", toolCalls: [] }] : []),
          ]
        : [],
      finalAssistantText: done ? options.final ?? "You missed 2 launch decisions." : "",
    })
  }
  const client = createHeadlessRunnerClient({
    config: { url: "http://headless-runner:8795", token: TOKEN },
    fetch: fetchImpl,
    mintToken: async (input) => {
      minted.push({ ttlMs: input.ttlMs, userId: input.userId })
      return { token: `ow_mcp_at_${minted.length}` }
    },
  })
  return { client, calls, minted, sessions, turns }
}

function runInput(overrides: Partial<CloudAgentExecutorInput> = {}) {
  const admitted: Array<Record<string, unknown>> = []
  const input: CloudAgentExecutorInput = {
    organizationId: "org_1",
    ownerMemberId: "member_1",
    automationRunId: "run_1",
    automationName: "What I missed in #launch",
    action: { kind: "agent", instructions: "Tell me what I missed in #launch.", model: { providerId: "ipr_1", modelId: "gwm_picked" } },
    maximumRuntimeMs: 15 * 60_000,
    previousReceipt: null,
    signal: new AbortController().signal,
    onAdmitted: async (receipt) => {
      admitted.push(receipt)
    },
    ...overrides,
  }
  return { input, admitted }
}

function deps(client: HeadlessAgentExecutorDeps["client"], overrides: Partial<HeadlessAgentExecutorDeps> = {}): Partial<HeadlessAgentExecutorDeps> {
  return {
    client,
    ownerUserId: async () => "usr_1",
    stillHeadless: async () => true,
    sleep: async (_ms, signal) => {
      signal.throwIfAborted()
      await Promise.resolve()
    },
    pollIntervalMs: 0,
    ...overrides,
  }
}

describe("headless Automation runs", () => {
  test("a run is one turn: receipt saved before the send, member token, result and events", async () => {
    const runner = fakeRunner()
    const { input, admitted } = runInput()
    const result = await executeHeadlessAgent(input, deps(runner.client))

    expect(result).toMatchObject({ ok: true, workspaceId: "headless", resultSummary: "You missed 2 launch decisions." })
    if (!result.ok) throw new Error("expected success")
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 90, costMicros: null })
    // The receipt exists before any work is sent, so a Den restart resumes this exact turn.
    expect(admitted).toEqual([{ runtime: "headless", sessionId: "hs_1", messageId: headlessMessageIdForRun("run_1") }])
    const order = runner.calls.map((call) => `${call.method} ${call.path}`)
    expect(order.indexOf("POST /v1/sessions")).toBeLessThan(order.indexOf("POST /v1/sessions/hs_1/turns"))
    expect(runner.sessions.get("hs_1")).toEqual({ title: "Automation: What I missed in #launch", instructions: HEADLESS_AUTOMATION_INSTRUCTIONS })
    expect(runner.minted).toEqual([{ userId: "usr_1", ttlMs: 20 * 60_000 }])
    const send = runner.calls.find((call) => call.path === "/v1/sessions/hs_1/turns")
    expect(send?.body).toEqual({
      messageId: headlessMessageIdForRun("run_1"),
      prompt: "Tell me what I missed in #launch.",
      credentials: { mcpToken: "ow_mcp_at_1" },
    })
    // The member picked a model the runner cannot serve, so the run says which model it used instead.
    expect(result.events[0]).toEqual({ type: "warning", payload: { code: "headless_default_model", requestedModel: "gwm_picked", model: "gwm_default" } })
    expect(result.events).toContainEqual({
      type: "capability_execution",
      payload: { messageId: headlessMessageIdForRun("run_1"), partId: "c1", callId: "c1", name: "execute_capability", status: "completed" },
    })
    expect(result.events.at(-1)).toEqual({ type: "terminal", payload: { status: "succeeded", model: "gwm_default" } })
  })

  test("a model the runner serves is used as picked", async () => {
    const runner = fakeRunner({ models: ["gwm_default", "gwm_picked"] })
    const result = await executeHeadlessAgent(runInput().input, deps(runner.client))
    expect(result.ok).toBe(true)
    expect(runner.calls.find((call) => call.path === "/v1/sessions/hs_1/turns")?.body).toMatchObject({ model: "gwm_picked" })
    if (result.ok) expect(result.events.some((event) => event.type === "warning")).toBe(false)
  })

  test("the cloud default model leaves the choice to the runner, without a warning", async () => {
    const runner = fakeRunner({ models: ["gwm_default", "gwm_picked"] })
    const result = await executeHeadlessAgent(
      runInput({ action: { kind: "agent", instructions: "Digest", model: { providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId } } }).input,
      deps(runner.client),
    )
    expect(result.ok).toBe(true)
    expect(runner.calls.some((call) => call.path === "/v1/models")).toBe(false)
    expect(runner.calls.find((call) => call.path === "/v1/sessions/hs_1/turns")?.body).not.toHaveProperty("model")
    if (result.ok) expect(result.events.some((event) => event.type === "warning")).toBe(false)
  })

  test("a runner restart mid-turn resumes the same turn with a fresh token", async () => {
    const runner = fakeRunner({ reads: ["running", "interrupted", "running", "completed"] })
    const result = await executeHeadlessAgent(runInput().input, deps(runner.client))
    expect(result.ok).toBe(true)
    const sends = runner.calls.filter((call) => call.path === "/v1/sessions/hs_1/turns")
    expect(sends).toHaveLength(2)
    expect(sends[0].body?.messageId).toBe(sends[1].body?.messageId)
    expect(runner.minted).toHaveLength(2)
  })

  test("Den recovery observes the receipt's turn instead of starting another", async () => {
    const runner = fakeRunner()
    runner.sessions.set("hs_9", {})
    const messageId = headlessMessageIdForRun("run_1")
    const { input, admitted } = runInput({ previousReceipt: { runtime: "headless", sessionId: "hs_9", messageId } })
    const result = await executeHeadlessAgent(input, deps(runner.client))
    expect(result.ok).toBe(true)
    expect(admitted).toEqual([])
    expect(runner.calls.some((call) => call.method === "POST" && call.path === "/v1/sessions")).toBe(false)
    expect(runner.calls.filter((call) => call.path === "/v1/sessions/hs_9/turns").map((call) => call.body?.messageId)).toEqual([messageId])
  })

  test("a receipt from an OpenWork Web computer is never continued here", async () => {
    const runner = fakeRunner()
    const result = await executeHeadlessAgent(
      runInput({ previousReceipt: { workerId: "w", workspaceId: "ws", nativeThreadId: "ses", messageId: "msg" } }).input,
      deps(runner.client),
    )
    expect(result).toMatchObject({ ok: false, code: "execution_runtime_unavailable", needsAttention: true, retryable: false })
    expect(runner.calls).toEqual([])
  })

  test("failures map onto the Automation contract", async () => {
    const mcp = await executeHeadlessAgent(runInput().input, deps(fakeRunner({ reads: ["failed"], error: "mcp_unavailable" }).client))
    expect(mcp).toMatchObject({ ok: false, code: "connect_access_unavailable", retryable: false })
    const model = await executeHeadlessAgent(runInput().input, deps(fakeRunner({ reads: ["failed"], error: "model_credentials_missing" }).client))
    expect(model).toMatchObject({ ok: false, code: "provider_unavailable", needsAttention: true })
    const timeout = await executeHeadlessAgent(runInput().input, deps(fakeRunner({ reads: ["failed"], error: "turn_timeout" }).client))
    expect(timeout).toMatchObject({ ok: false, code: "execution_timed_out" })
  })

  test("a runner that is down before anything ran is retried; a missing owner needs attention", async () => {
    const down = await executeHeadlessAgent(runInput().input, deps(fakeRunner({ createStatus: 503 }).client))
    expect(down).toMatchObject({ ok: false, code: "execution_runtime_unavailable", retryable: true })
    const gone = await executeHeadlessAgent(runInput().input, deps(fakeRunner().client, { ownerUserId: async () => null }))
    expect(gone).toMatchObject({ ok: false, code: "owner_membership_lost", needsAttention: true })
    const unconfigured = await executeHeadlessAgent(runInput().input, deps(null))
    expect(unconfigured).toMatchObject({ ok: false, code: "execution_runtime_unavailable", needsAttention: true })
  })

  test("cancelling stops the runner's turn before the run ends", async () => {
    const runner = fakeRunner({ reads: ["running", "running", "running", "running", "running"] })
    const controller = new AbortController()
    let polls = 0
    const result = await executeHeadlessAgent(
      runInput({ signal: controller.signal }).input,
      deps(runner.client, {
        sleep: async (_ms, signal) => {
          polls += 1
          if (polls === 3) controller.abort(new Error("cancel"))
          signal.throwIfAborted()
        },
      }),
    )
    expect(result).toMatchObject({ ok: false, status: "cancelled", code: "cancelled" })
    expect(runner.calls.some((call) => call.path === "/v1/sessions/hs_1/abort")).toBe(true)
    expect(runner.turns.get(`hs_1:${headlessMessageIdForRun("run_1")}`)?.status).toBe("aborted")
  })

  test("receipts are parsed strictly", () => {
    expect(parseHeadlessReceipt({ runtime: "headless", sessionId: "hs_1", messageId: "auto_1" })).toEqual({ runtime: "headless", sessionId: "hs_1", messageId: "auto_1" })
    expect(parseHeadlessReceipt({ sessionId: "hs_1", messageId: "auto_1" })).toBeNull()
    expect(parseHeadlessReceipt({ runtime: "headless", sessionId: "", messageId: "auto_1" })).toBeNull()
    expect(parseHeadlessReceipt(null)).toBeNull()
  })
})

describe("the cloud default model", () => {
  const store = (active: boolean): AutomationModelAuthorityStore => ({
    findActiveMember: async () => (active ? { id: "member_1" } : null),
    findOpenWorkProvider: async () => null,
    findProvider: async () => null,
    findModel: async () => null,
    canAccessProvider: async () => false,
    allowsZenModel: async () => false,
  })

  test("needs only an active owner; placement is checked where Automations are created", async () => {
    const selection = { organizationId: "org_1", ownerMemberId: "member_1", providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId }
    expect(await resolveAutomationModelAccessWithStore(selection, store(true))).toMatchObject({ ok: true, value: { accessKind: "cloud_default", providerRecordId: null } })
    expect(await resolveAutomationModelAccessWithStore(selection, store(false))).toMatchObject({ ok: false, code: "owner_membership_lost" })
    expect(await resolveAutomationModelAccessWithStore({ ...selection, modelId: "other" }, store(true))).toMatchObject({ ok: false, code: "model_access_lost" })
  })
})
