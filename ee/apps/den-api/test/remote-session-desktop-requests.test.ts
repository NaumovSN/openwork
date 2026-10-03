import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test"

import { eq } from "@openwork-ee/den-db/drizzle"
import {
  RemoteSessionCommandTable,
  RemoteSessionRequestTable,
} from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  type AutomationDesktopRunnerCapability,
  type RemoteSessionReadResult,
} from "@openwork/types/automations"
import { Hono } from "hono"
import type {
  RemoteSessionExecuteDeps,
  RemoteSessionRuntime,
  RemoteSessionThreadClient,
  RemoteSessionToolResult,
} from "../src/mcp/remote-session-capabilities.js"
import type {
  RemoteSessionCommandStore,
  RemoteSessionDesktopSession,
} from "../src/remote-sessions/commands.js"
import type { RemoteSessionRequest, RemoteSessionRequestStore } from "../src/remote-sessions/requests.js"
import type { OrganizationContextVariables } from "../src/middleware/index.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
}

type RemoteSessionModule = typeof import("../src/mcp/remote-session-capabilities.js")
type EnvModule = typeof import("../src/env.js")

let executeRemoteSessionCapability: RemoteSessionModule["executeRemoteSessionCapability"]
let deploymentEnv: EnvModule["env"]
let previousRuntimeEnabled = false

beforeAll(async () => {
  seedRequiredEnv()
  executeRemoteSessionCapability = (await import("../src/mcp/remote-session-capabilities.js")).executeRemoteSessionCapability
  deploymentEnv = (await import("../src/env.js")).env
  previousRuntimeEnabled = deploymentEnv.automations.runtimeEnabled
  // Desktop sessions are only looked up where desktop runners are enabled.
  deploymentEnv.automations.runtimeEnabled = true
})

afterAll(() => {
  deploymentEnv.automations.runtimeEnabled = previousRuntimeEnabled
})

const ORGANIZATION_ID = createDenTypeId("organization")
const MEMBER_ID = createDenTypeId("member")
const USER_ID = createDenTypeId("user")
const COMMAND_ID = createDenTypeId("remoteSessionCommand")
const REQUEST_ID = createDenTypeId("remoteSessionRequest")
const RUNTIME: RemoteSessionRuntime = {
  workerId: "worker_fixture",
  baseUrl: "http://worker.fixture",
  workspaceId: "ws_cloud",
  clientToken: "client-token",
  hostToken: "host-token",
}

const DESKTOP_SESSION: RemoteSessionDesktopSession = {
  commandId: COMMAND_ID,
  ownerMemberId: MEMBER_ID,
  runnerId: "runner-a",
  sessionId: "ses_desktop",
  workspaceId: "ws_desktop",
  title: "Desktop handoff",
  engine: "v2",
  status: "idle",
  updatedAt: 1_000,
}

const READ_RESULT: RemoteSessionReadResult = {
  title: "Desktop handoff",
  status: "idle",
  waitingFor: null,
  lastError: null,
  messageCount: 2,
  from: "end",
  messages: [
    { id: "msg_1", role: "user", createdAt: 1, text: "Inspect the repo", truncated: false, toolCalls: [], error: null },
    {
      id: "msg_2",
      role: "assistant",
      createdAt: 2,
      text: "Three files changed.",
      truncated: false,
      toolCalls: [{ id: "prt_1", name: "bash", status: "completed", input: "{\"command\":\"ls\"}", output: "a\nb", error: null, truncated: false }],
      error: null,
    },
  ],
  nextCursor: null,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function payload(result: RemoteSessionToolResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.content[0]?.text ?? "{}")
  if (!isRecord(parsed)) throw new Error("Remote-session result was not an object")
  return parsed
}

function unavailable(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} not stubbed for this test`)
  }
}

function commandStore(overrides: Partial<RemoteSessionCommandStore> = {}): RemoteSessionCommandStore {
  return {
    enqueue: overrides.enqueue ?? unavailable("enqueue"),
    claim: overrides.claim ?? unavailable("claim"),
    complete: overrides.complete ?? unavailable("complete"),
    report: overrides.report ?? unavailable("report"),
    get: overrides.get ?? unavailable("get"),
    listPendingForRunner: overrides.listPendingForRunner ?? unavailable("listPendingForRunner"),
    findDesktopSession: overrides.findDesktopSession ?? (async () => DESKTOP_SESSION),
    listDesktopSessions: overrides.listDesktopSessions ?? unavailable("listDesktopSessions"),
    markTurnStarted: overrides.markTurnStarted ?? unavailable("markTurnStarted"),
  }
}

function pendingRequest(input: Parameters<RemoteSessionRequestStore["enqueue"]>[0]): RemoteSessionRequest {
  const now = Date.now()
  const base = {
    id: REQUEST_ID,
    organizationId: input.organizationId,
    ownerMemberId: input.ownerMemberId,
    createdByUserId: input.createdByUserId,
    commandId: input.commandId,
    targetRunnerId: input.targetRunnerId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    engine: input.engine,
    status: "pending" as const,
    outcome: null,
    error: null,
    expiresAt: now + input.ttlMs,
    claimedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  if (input.action === "read") return { ...base, action: "read", input: input.input }
  if (input.action === "send") return { ...base, action: "send", input: input.input }
  return { ...base, action: "stop", input: input.input }
}

/** A request store whose runner answers after `answerAfterGets` polls. */
function answeringRequestStore(input: {
  answer: (request: RemoteSessionRequest) => RemoteSessionRequest
  answerAfterGets?: number
}) {
  const enqueued: Parameters<RemoteSessionRequestStore["enqueue"]>[0][] = []
  let stored: RemoteSessionRequest | null = null
  let gets = 0
  const store: RemoteSessionRequestStore = {
    enqueue: async (request) => {
      enqueued.push(request)
      stored = pendingRequest(request)
      return stored
    },
    claim: unavailable("claim"),
    complete: unavailable("complete"),
    get: async () => {
      gets += 1
      if (!stored) return null
      if (gets >= (input.answerAfterGets ?? 1)) stored = input.answer(stored)
      return stored
    },
    listPendingForRunner: unavailable("listPendingForRunner"),
  }
  return { store, enqueued, gets: () => gets }
}

function deps(input: {
  commandStore?: RemoteSessionCommandStore
  requestStore?: RemoteSessionRequestStore
  runner?: { connected: boolean; controlCapable: boolean }
  webAccess?: boolean
  createClient?: RemoteSessionExecuteDeps["createClient"]
  requestWait?: { timeoutMs: number; pollMs: number }
} = {}): RemoteSessionExecuteDeps {
  return {
    getOpenWorkWebAccess: async () => ({ hasAccess: input.webAccess ?? true }),
    commandStore: input.commandStore ?? commandStore(),
    desktopPresence: unavailable("desktopPresence"),
    resolveRuntime: async () => ({ ok: true, runtime: RUNTIME }),
    createClient: input.createClient ?? (() => { throw new Error("A desktop session must not reach the Cloud client") }),
    requestStore: input.requestStore ?? {
      enqueue: unavailable("request enqueue"),
      claim: unavailable("request claim"),
      complete: unavailable("request complete"),
      get: unavailable("request get"),
      listPendingForRunner: unavailable("request listPendingForRunner"),
    },
    desktopRunner: async () => input.runner ?? { connected: true, controlCapable: true },
    requestWait: input.requestWait ?? { timeoutMs: 200, pollMs: 5 },
  }
}

function executeInput(action: "read" | "send" | "stop" | "list", body: unknown, hasWriteScope = true) {
  return { action, organizationId: ORGANIZATION_ID, userId: USER_ID, hasWriteScope, body }
}

test("read of a desktop session asks the delivering runner and returns its transcript page", async () => {
  const lookups: Parameters<RemoteSessionCommandStore["findDesktopSession"]>[0][] = []
  const requests = answeringRequestStore({
    answerAfterGets: 2,
    answer: (request) => ({ ...request, status: "done", outcome: { action: "read", result: READ_RESULT } }),
  })
  const result = await executeRemoteSessionCapability(
    executeInput("read", { sessionId: "ses_desktop", workspaceId: "ws_desktop", from: "start", cursor: "msg_0", limit: 2 }),
    deps({
      commandStore: commandStore({ findDesktopSession: async (lookup) => { lookups.push(lookup); return DESKTOP_SESSION } }),
      requestStore: requests.store,
    }),
  )

  expect(result.isError).toBeUndefined()
  expect(lookups).toEqual([{
    organizationId: ORGANIZATION_ID,
    createdByUserId: USER_ID,
    sessionId: "ses_desktop",
    workspaceId: "ws_desktop",
  }])
  expect(requests.enqueued).toEqual([{
    action: "read",
    input: { from: "start", cursor: "msg_0", limit: 2 },
    organizationId: ORGANIZATION_ID,
    ownerMemberId: MEMBER_ID,
    createdByUserId: USER_ID,
    commandId: COMMAND_ID,
    targetRunnerId: "runner-a",
    workspaceId: "ws_desktop",
    sessionId: "ses_desktop",
    engine: "v2",
    ttlMs: 120_000,
  }])
  expect(payload(result)).toEqual({
    target: "desktop",
    requestId: REQUEST_ID,
    sessionId: "ses_desktop",
    workspaceId: "ws_desktop",
    state: "done",
    ...READ_RESULT,
  })
})

test("a desktop that does not answer in time returns a requestId that read collects later", async () => {
  let answered = false
  const requests = answeringRequestStore({
    answerAfterGets: 1,
    answer: (request) => answered
      ? { ...request, status: "done", outcome: { action: "read", result: READ_RESULT } }
      : { ...request, status: "claimed", claimedAt: Date.now() },
  })
  const startedAt = Date.now()
  const pending = await executeRemoteSessionCapability(
    executeInput("read", { sessionId: "ses_desktop" }),
    deps({ requestStore: requests.store, requestWait: { timeoutMs: 40, pollMs: 5 } }),
  )
  expect(Date.now() - startedAt).toBeLessThan(1_000)
  expect(pending.isError).toBeUndefined()
  expect(payload(pending)).toMatchObject({
    target: "desktop",
    state: "pending",
    action: "read",
    requestId: REQUEST_ID,
    sessionId: "ses_desktop",
  })
  expect(requests.enqueued[0]?.input).toEqual({ from: "end", cursor: null, limit: 20 })

  answered = true
  // Collecting a result needs neither Web access nor a desktop lookup.
  const collected = await executeRemoteSessionCapability(
    executeInput("read", { requestId: REQUEST_ID }, false),
    deps({
      requestStore: requests.store,
      webAccess: false,
      commandStore: commandStore({ findDesktopSession: unavailable("findDesktopSession") }),
    }),
  )
  expect(payload(collected)).toMatchObject({ state: "done", requestId: REQUEST_ID, messages: READ_RESULT.messages })
})

test("read by requestId reports expired, failed, and unknown requests", async () => {
  const base = pendingRequest({
    action: "send",
    input: { prompt: "Continue", messageId: null, model: null },
    organizationId: ORGANIZATION_ID,
    ownerMemberId: MEMBER_ID,
    createdByUserId: USER_ID,
    commandId: COMMAND_ID,
    targetRunnerId: "runner-a",
    workspaceId: "ws_desktop",
    sessionId: "ses_desktop",
    engine: null,
    ttlMs: 1,
  })
  const answers: Array<RemoteSessionRequest | null> = [
    { ...base, status: "expired" },
    { ...base, status: "failed", error: { code: "unknown_session", message: "The local session is no longer available." } },
    null,
  ]
  const store: RemoteSessionRequestStore = {
    enqueue: unavailable("enqueue"),
    claim: unavailable("claim"),
    complete: unavailable("complete"),
    get: async () => answers.shift() ?? null,
    listPendingForRunner: unavailable("listPendingForRunner"),
  }
  const read = () => executeRemoteSessionCapability(executeInput("read", { requestId: REQUEST_ID }), deps({ requestStore: store }))

  const expired = await read()
  expect(expired.isError).toBe(true)
  expect(payload(expired)).toMatchObject({ error: "desktop_request_expired", action: "send", retryable: true })
  const failed = await read()
  expect(failed.isError).toBe(true)
  expect(payload(failed)).toMatchObject({ error: "unknown_session", retryable: false })
  const unknown = await read()
  expect(payload(unknown)).toEqual({ error: "unknown_request", retryable: false })
})

test("send to a desktop session queues the follow-up and reports the accepted turn", async () => {
  const requests = answeringRequestStore({
    answer: (request) => ({ ...request, status: "done", outcome: { action: "send", result: { messageId: "msg_abc", alreadyPresent: false } } }),
  })
  const result = await executeRemoteSessionCapability(
    executeInput("send", {
      sessionId: "ses_desktop",
      prompt: "Now add tests",
      messageId: "msg_abc",
      model: { providerId: "provider", modelId: "model" },
    }),
    deps({ requestStore: requests.store }),
  )
  expect(requests.enqueued[0]).toMatchObject({
    action: "send",
    input: { prompt: "Now add tests", messageId: "msg_abc", model: { providerId: "provider", modelId: "model", variant: null } },
  })
  expect(payload(result)).toMatchObject({
    target: "desktop",
    sessionId: "ses_desktop",
    commandId: COMMAND_ID,
    state: "accepted",
    messageId: "msg_abc",
    alreadyPresent: false,
  })
})

test("stop on a desktop session asks the runner and returns whether it stopped", async () => {
  const requests = answeringRequestStore({
    answer: (request) => ({ ...request, status: "done", outcome: { action: "stop", result: { stopped: false, reason: "different_turn" } } }),
  })
  const result = await executeRemoteSessionCapability(
    executeInput("stop", { sessionId: "ses_desktop", messageId: "msg_old" }),
    deps({ requestStore: requests.store }),
  )
  expect(requests.enqueued[0]).toMatchObject({ action: "stop", input: { messageId: "msg_old" } })
  expect(payload(result)).toMatchObject({ target: "desktop", sessionId: "ses_desktop", stopped: false, reason: "different_turn" })
})

test("send and stop on a desktop session still require the write scope", async () => {
  for (const action of ["send", "stop"] as const) {
    const result = await executeRemoteSessionCapability(
      executeInput(action, { sessionId: "ses_desktop", prompt: "x" }, false),
      deps({ commandStore: commandStore({ findDesktopSession: unavailable("findDesktopSession") }) }),
    )
    expect(payload(result).error).toBe("insufficient_mcp_scope")
  }
})

test("an outdated or offline owning desktop is reported without queuing a request", async () => {
  const outdated = await executeRemoteSessionCapability(
    executeInput("read", { sessionId: "ses_desktop" }),
    deps({ runner: { connected: true, controlCapable: false } }),
  )
  expect(outdated.isError).toBe(true)
  expect(payload(outdated)).toMatchObject({ error: "desktop_update_required", commandId: COMMAND_ID, retryable: false })

  const offline = await executeRemoteSessionCapability(
    executeInput("send", { sessionId: "ses_desktop", prompt: "Continue" }),
    deps({ runner: { connected: false, controlCapable: true } }),
  )
  expect(offline.isError).toBe(true)
  expect(payload(offline)).toMatchObject({ error: "desktop_offline", retryable: true })
})

test("desktop session control requires Web access like the Cloud path", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("read", { sessionId: "ses_desktop" }),
    deps({ webAccess: false, commandStore: commandStore({ findDesktopSession: unavailable("findDesktopSession") }) }),
  )
  expect(payload(result).error).toBe("openwork_web_access_required")
})

test("a session no desktop command created keeps the Cloud path unchanged", async () => {
  const sent: Array<{ sessionId: string; prompt: string }> = []
  const client: RemoteSessionThreadClient = {
    createThread: unavailable("createThread"),
    getThreadSnapshot: unavailable("getThreadSnapshot"),
    sendTurn: async (sessionId, turn) => {
      sent.push({ sessionId, prompt: turn.prompt })
      return { threadId: sessionId, acceptedAt: 1, messageCountBefore: 0, messageId: null, alreadyPresent: false }
    },
  }
  const result = await executeRemoteSessionCapability(
    executeInput("send", { sessionId: "ses_cloud", prompt: "Continue" }),
    deps({ commandStore: commandStore({ findDesktopSession: async () => null }), createClient: () => client }),
  )
  expect(sent).toEqual([{ sessionId: "ses_cloud", prompt: "Continue" }])
  expect(payload(result)).toMatchObject({ target: "cloud", sessionId: "ses_cloud", state: "accepted" })
})

test("Cloud-only deployments never look up desktop sessions", async () => {
  deploymentEnv.automations.runtimeEnabled = false
  try {
    const client: RemoteSessionThreadClient = {
      createThread: unavailable("createThread"),
      sendTurn: unavailable("sendTurn"),
      getThreadSnapshot: async (sessionId) => ({
        threadId: sessionId,
        title: null,
        directory: null,
        status: { type: "idle" },
        messages: [],
        todos: [],
      }),
    }
    const result = await executeRemoteSessionCapability(
      executeInput("read", { sessionId: "ses_cloud" }),
      deps({ commandStore: commandStore({ findDesktopSession: unavailable("findDesktopSession") }), createClient: () => client }),
    )
    expect(payload(result)).toMatchObject({ target: "cloud", sessionId: "ses_cloud" })
  } finally {
    deploymentEnv.automations.runtimeEnabled = true
  }
})

test("list returns the member's desktop sessions from Den without a desktop round-trip", async () => {
  const queries: Parameters<RemoteSessionCommandStore["listDesktopSessions"]>[0][] = []
  const result = await executeRemoteSessionCapability(
    executeInput("list", { target: "desktop", workspaceId: "ws_desktop", limit: 5 }, false),
    deps({
      webAccess: false,
      commandStore: commandStore({
        listDesktopSessions: async (query) => { queries.push(query); return [DESKTOP_SESSION] },
      }),
    }),
  )
  expect(queries).toEqual([{ organizationId: ORGANIZATION_ID, createdByUserId: USER_ID, workspaceId: "ws_desktop", limit: 5 }])
  expect(payload(result)).toEqual({
    target: "desktop",
    sessions: [{
      sessionId: "ses_desktop",
      workspaceId: "ws_desktop",
      commandId: COMMAND_ID,
      title: "Desktop handoff",
      status: "idle",
      updatedAt: 1_000,
    }],
  })

  const invalid = await Promise.all([
    executeRemoteSessionCapability(executeInput("list", { target: "cloud" }), deps()),
    executeRemoteSessionCapability(executeInput("list", { target: "desktop", limit: 51 }), deps()),
  ])
  for (const item of invalid) expect(payload(item).error).toBe("invalid_capability_arguments")
})

test("read accepts exactly one of sessionId, commandId, or requestId", async () => {
  const results = await Promise.all([
    executeRemoteSessionCapability(executeInput("read", { sessionId: "ses_desktop", requestId: REQUEST_ID }), deps()),
    executeRemoteSessionCapability(executeInput("read", { commandId: COMMAND_ID, requestId: REQUEST_ID }), deps()),
    executeRemoteSessionCapability(executeInput("read", { sessionId: "ses_desktop", limit: 101 }), deps()),
  ])
  for (const result of results) expect(payload(result).error).toBe("invalid_capability_arguments")
})

// ---------------------------------------------------------------------------
// Database-backed routing, runner routes, and expiry.
// ---------------------------------------------------------------------------

async function runnerApp(input: { requestStore?: RemoteSessionRequestStore; commandStore?: RemoteSessionCommandStore } = {}) {
  const { AutomationService } = await import("../src/automations/service.js")
  const { automationRunnerAuth } = await import("../src/automations/runner-auth.js")
  const { registerAutomationRoutes } = await import("../src/routes/automations/index.js")
  const service = new AutomationService()
  service.isActiveRunnerOwner = async () => true
  service.discoverDesktopRunnerWork = async () => []
  const app = new Hono<{ Variables: Partial<OrganizationContextVariables> }>()
  registerAutomationRoutes(app, {
    service,
    ...(input.requestStore ? { requestStore: input.requestStore } : {}),
    ...(input.commandStore ? { commandStore: input.commandStore } : {}),
  })
  const tokenFor = (scope: {
    organizationId: string
    ownerMemberId: string
    runnerId: string
    capabilities: AutomationDesktopRunnerCapability[]
  }) => automationRunnerAuth.issue(scope, "http://den.local").token
  const call = (token: string, path: string, body?: unknown) => app.request(`http://den.local${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { tokenFor, call }
}

async function deliveredCommand(input: {
  organizationId: string
  ownerMemberId: string
  createdByUserId: string
  runnerId: string
  sessionId: string
  workspaceId: string
  title?: string
}) {
  const { databaseRemoteSessionCommandStore } = await import("../src/remote-sessions/commands.js")
  const queued = await databaseRemoteSessionCommandStore.enqueue({
    organizationId: input.organizationId,
    ownerMemberId: input.ownerMemberId,
    createdByUserId: input.createdByUserId,
    title: input.title ?? "Desktop handoff",
    prompt: "Inspect the repo",
    ttlMs: 600_000,
    idempotencyKey: createDenTypeId("remoteSessionCommand"),
  })
  await databaseRemoteSessionCommandStore.claim({
    commandId: queued.id,
    organizationId: input.organizationId,
    ownerMemberId: input.ownerMemberId,
    runnerId: input.runnerId,
    now: Date.now(),
  })
  await databaseRemoteSessionCommandStore.complete({
    commandId: queued.id,
    runnerId: input.runnerId,
    status: "delivered",
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  })
  return queued.id
}

async function cleanup(organizationId: string) {
  const { db } = await import("../src/db.js")
  await db.delete(RemoteSessionRequestTable).where(eq(RemoteSessionRequestTable.org_id, organizationId))
  await db.delete(RemoteSessionCommandTable).where(eq(RemoteSessionCommandTable.org_id, organizationId))
}

test("db: a session routes to the runner that delivered it, scoped to its creator and workspace", async () => {
  const { databaseRemoteSessionCommandStore: store } = await import("../src/remote-sessions/commands.js")
  const organizationId = createDenTypeId("organization")
  const ownerMemberId = createDenTypeId("member")
  const createdByUserId = createDenTypeId("user")
  try {
    const commandId = await deliveredCommand({
      organizationId, ownerMemberId, createdByUserId, runnerId: "runner-a", sessionId: "ses_routed", workspaceId: "ws_a",
    })
    const owner = await store.findDesktopSession({ organizationId, createdByUserId, sessionId: "ses_routed" })
    expect(owner).toMatchObject({ commandId, ownerMemberId, runnerId: "runner-a", sessionId: "ses_routed", workspaceId: "ws_a", engine: null })
    expect(await store.findDesktopSession({ organizationId, createdByUserId, sessionId: "ses_routed", workspaceId: "ws_a" })).not.toBeNull()
    expect(await store.findDesktopSession({ organizationId, createdByUserId, sessionId: "ses_routed", workspaceId: "ws_b" })).toBeNull()
    expect(await store.findDesktopSession({ organizationId, createdByUserId: createDenTypeId("user"), sessionId: "ses_routed" })).toBeNull()
    expect(await store.findDesktopSession({ organizationId, createdByUserId, sessionId: "ses_cloud" })).toBeNull()
    expect(await store.findDesktopSession({ organizationId, createdByUserId: "not-a-den-id", sessionId: "ses_routed" })).toBeNull()

    // A command that is still pending owns no session yet.
    await store.enqueue({
      organizationId, ownerMemberId, createdByUserId, title: "Pending", ttlMs: 600_000,
      idempotencyKey: createDenTypeId("remoteSessionCommand"),
    })
    const listed = await store.listDesktopSessions({ organizationId, createdByUserId, limit: 10 })
    expect(listed.map((session) => session.sessionId)).toEqual(["ses_routed"])
  } finally {
    await cleanup(organizationId)
  }
})

test("db: list returns newest desktop sessions first, filtered by workspace and bounded", async () => {
  const { databaseRemoteSessionCommandStore: store } = await import("../src/remote-sessions/commands.js")
  const organizationId = createDenTypeId("organization")
  const ownerMemberId = createDenTypeId("member")
  const createdByUserId = createDenTypeId("user")
  const scope = { organizationId, ownerMemberId, createdByUserId, runnerId: "runner-a" }
  try {
    setSystemTime(new Date("2026-09-01T10:00:00.000Z"))
    await deliveredCommand({ ...scope, sessionId: "ses_old", workspaceId: "ws_a", title: "Old" })
    setSystemTime(new Date("2026-09-01T11:00:00.000Z"))
    await deliveredCommand({ ...scope, sessionId: "ses_mid", workspaceId: "ws_b", title: "Mid" })
    setSystemTime(new Date("2026-09-01T12:00:00.000Z"))
    await deliveredCommand({ ...scope, sessionId: "ses_new", workspaceId: "ws_a", title: "New" })
    setSystemTime()

    const all = await store.listDesktopSessions({ organizationId, createdByUserId, limit: 10 })
    expect(all.map((session) => session.title)).toEqual(["New", "Mid", "Old"])
    const limited = await store.listDesktopSessions({ organizationId, createdByUserId, limit: 1 })
    expect(limited.map((session) => session.sessionId)).toEqual(["ses_new"])
    const filtered = await store.listDesktopSessions({ organizationId, createdByUserId, workspaceId: "ws_a", limit: 10 })
    expect(filtered.map((session) => session.sessionId)).toEqual(["ses_new", "ses_old"])
  } finally {
    setSystemTime()
    await cleanup(organizationId)
  }
})

test("db: requests reach only their target runner with the control capability, and claim and complete once", async () => {
  const { databaseRemoteSessionRequestStore: requests } = await import("../src/remote-sessions/requests.js")
  const { databaseRemoteSessionCommandStore: commands } = await import("../src/remote-sessions/commands.js")
  const { db } = await import("../src/db.js")
  const organizationId = createDenTypeId("organization")
  const ownerMemberId = createDenTypeId("member")
  const createdByUserId = createDenTypeId("user")
  try {
    const commandId = await deliveredCommand({
      organizationId, ownerMemberId, createdByUserId, runnerId: "runner-a", sessionId: "ses_flow", workspaceId: "ws_a",
    })
    await commands.report({
      commandId, organizationId, ownerMemberId, runnerId: "runner-a",
      status: "idle", finalText: "First answer", engine: "v2", observedAt: Date.now(),
    })
    const read = await requests.enqueue({
      action: "read",
      input: { from: "end", cursor: null, limit: 20 },
      organizationId, ownerMemberId, createdByUserId, commandId,
      targetRunnerId: "runner-a", workspaceId: "ws_a", sessionId: "ses_flow", engine: "v2", ttlMs: 120_000,
    })
    const send = await requests.enqueue({
      action: "send",
      input: { prompt: "Continue", messageId: "msg_follow", model: null },
      organizationId, ownerMemberId, createdByUserId, commandId,
      targetRunnerId: "runner-a", workspaceId: "ws_a", sessionId: "ses_flow", engine: "v2", ttlMs: 120_000,
    })

    const { tokenFor, call } = await runnerApp()
    const scope = { organizationId, ownerMemberId }
    const controlA = tokenFor({ ...scope, runnerId: "runner-a", capabilities: [REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY, REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY] })
    const legacyA = tokenFor({ ...scope, runnerId: "runner-a", capabilities: [REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY] })
    const controlB = tokenFor({ ...scope, runnerId: "runner-b", capabilities: [REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY, REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY] })

    const requestItems = [
      { kind: "remote_session_request", requestId: read.id },
      { kind: "remote_session_request", requestId: send.id },
    ]
    expect(await (await call(controlA, "/v1/automation-runner/work")).json()).toEqual({ items: requestItems })
    expect(await (await call(controlA, "/v1/remote-session-requests/pending")).json()).toEqual({ items: requestItems })
    expect(await (await call(legacyA, "/v1/automation-runner/work")).json()).toEqual({ items: [] })
    expect(await (await call(legacyA, "/v1/remote-session-requests/pending")).json()).toEqual({ items: [] })
    expect(await (await call(controlB, "/v1/remote-session-requests/pending")).json()).toEqual({ items: [] })

    expect((await call(legacyA, `/v1/remote-session-requests/${read.id}/claim`, {})).status).toBe(403)
    expect((await call(controlB, `/v1/remote-session-requests/${read.id}/claim`, {})).status).toBe(409)
    const claimed = await call(controlA, `/v1/remote-session-requests/${read.id}/claim`, {})
    expect(claimed.status).toBe(200)
    expect(await claimed.json()).toEqual({
      assignment: {
        requestId: read.id,
        kind: "remote_session_request",
        commandId,
        sessionId: "ses_flow",
        workspaceId: "ws_a",
        engine: "v2",
        expiresAt: read.expiresAt,
        action: "read",
        input: { from: "end", cursor: null, limit: 20 },
      },
    })
    expect((await call(controlA, `/v1/remote-session-requests/${read.id}/claim`, {})).status).toBe(409)
    expect(await (await call(controlA, "/v1/remote-session-requests/pending")).json()).toEqual({ items: [requestItems[1]] })

    // The outcome must answer the action and stay within 256 KB.
    const wrongAction = await call(controlA, `/v1/remote-session-requests/${read.id}/complete`, {
      status: "done", outcome: { action: "stop", result: { stopped: true, reason: null } },
    })
    expect(wrongAction.status).toBe(409)
    const oversized = await call(controlA, `/v1/remote-session-requests/${read.id}/complete`, {
      status: "done",
      outcome: {
        action: "read",
        result: {
          ...READ_RESULT,
          messages: Array.from({ length: 20 }, (_, index) => ({
            id: `msg_${index}`, role: "assistant", createdAt: null, text: "x".repeat(20_000), truncated: true, toolCalls: [], error: null,
          })),
        },
      },
    })
    expect(oversized.status).toBe(400)
    expect((await call(controlB, `/v1/remote-session-requests/${read.id}/complete`, {
      status: "done", outcome: { action: "read", result: READ_RESULT },
    })).status).toBe(409)
    const completed = await call(controlA, `/v1/remote-session-requests/${read.id}/complete`, {
      status: "done", outcome: { action: "read", result: READ_RESULT },
    })
    expect(completed.status).toBe(200)
    expect(await completed.json()).toEqual({ request: { id: read.id, status: "done" } })
    expect((await call(controlA, `/v1/remote-session-requests/${read.id}/complete`, {
      status: "failed", error: { code: "request_failed", message: "late" },
    })).status).toBe(409)
    expect(await requests.get({ requestId: read.id, organizationId, createdByUserId })).toMatchObject({
      status: "done",
      outcome: { action: "read", result: READ_RESULT },
    })
    // Another user cannot collect it.
    expect(await requests.get({ requestId: read.id, organizationId, createdByUserId: createDenTypeId("user") })).toBeNull()

    // An accepted follow-up marks the command running again.
    expect((await call(controlA, `/v1/remote-session-requests/${send.id}/claim`, {})).status).toBe(200)
    const sent = await call(controlA, `/v1/remote-session-requests/${send.id}/complete`, {
      status: "done", outcome: { action: "send", result: { messageId: "msg_follow", alreadyPresent: false } },
    })
    expect(sent.status).toBe(200)
    const rows = await db.select().from(RemoteSessionCommandTable).where(eq(RemoteSessionCommandTable.id, commandId))
    expect(rows[0]).toMatchObject({ session_status: "running", session_final_text: null, session_engine: "v2" })
  } finally {
    await cleanup(organizationId)
  }
})

test("db: an unanswered request expires; it can no longer be claimed and read reports it expired", async () => {
  const { databaseRemoteSessionRequestStore: requests } = await import("../src/remote-sessions/requests.js")
  const organizationId = createDenTypeId("organization")
  const ownerMemberId = createDenTypeId("member")
  const createdByUserId = createDenTypeId("user")
  try {
    const commandId = await deliveredCommand({
      organizationId, ownerMemberId, createdByUserId, runnerId: "runner-a", sessionId: "ses_exp", workspaceId: "ws_a",
    })
    setSystemTime(new Date("2026-09-01T10:00:00.000Z"))
    const request = await requests.enqueue({
      action: "stop",
      input: { messageId: null },
      organizationId, ownerMemberId, createdByUserId, commandId,
      targetRunnerId: "runner-a", workspaceId: "ws_a", sessionId: "ses_exp", engine: null, ttlMs: 120_000,
    })
    const later = new Date("2026-09-01T10:02:01.000Z").getTime()
    setSystemTime(new Date(later))
    expect(await requests.listPendingForRunner({ organizationId, ownerMemberId, runnerId: "runner-a", now: later, limit: 5 })).toEqual([])
    expect(await requests.claim({ requestId: request.id, organizationId, ownerMemberId, runnerId: "runner-a", now: later })).toBeNull()
    expect(await requests.get({ requestId: request.id, organizationId, createdByUserId })).toMatchObject({ status: "expired" })
    expect(await requests.claim({ requestId: "not-a-request-id", organizationId, ownerMemberId, runnerId: "runner-a", now: later })).toBeNull()
  } finally {
    setSystemTime()
    await cleanup(organizationId)
  }
})

test("db: an MCP read long-polls while the owning runner claims and answers over its routes", async () => {
  const { databaseRemoteSessionRequestStore: requests } = await import("../src/remote-sessions/requests.js")
  const { databaseRemoteSessionCommandStore: commands } = await import("../src/remote-sessions/commands.js")
  const organizationId = createDenTypeId("organization")
  const ownerMemberId = createDenTypeId("member")
  const createdByUserId = createDenTypeId("user")
  try {
    await deliveredCommand({
      organizationId, ownerMemberId, createdByUserId, runnerId: "runner-a", sessionId: "ses_live", workspaceId: "ws_a",
    })
    const { tokenFor, call } = await runnerApp()
    const token = tokenFor({
      organizationId, ownerMemberId, runnerId: "runner-a",
      capabilities: [REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY, REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY],
    })
    const runner = (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const pending: unknown = await (await call(token, "/v1/remote-session-requests/pending")).json()
        const item = isRecord(pending) && Array.isArray(pending.items) ? pending.items[0] : null
        if (isRecord(item) && typeof item.requestId === "string") {
          expect((await call(token, `/v1/remote-session-requests/${item.requestId}/claim`, {})).status).toBe(200)
          expect((await call(token, `/v1/remote-session-requests/${item.requestId}/complete`, {
            status: "done", outcome: { action: "read", result: READ_RESULT },
          })).status).toBe(200)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error("the runner never saw the request")
    })()
    const result = await executeRemoteSessionCapability(
      { action: "read", organizationId, userId: createdByUserId, hasWriteScope: false, body: { sessionId: "ses_live" } },
      {
        getOpenWorkWebAccess: async () => ({ hasAccess: true }),
        commandStore: commands,
        requestStore: requests,
        desktopPresence: unavailable("desktopPresence"),
        desktopRunner: async () => ({ connected: true, controlCapable: true }),
        resolveRuntime: unavailable("resolveRuntime"),
        createClient: () => { throw new Error("A desktop session must not reach the Cloud client") },
        requestWait: { timeoutMs: 5_000, pollMs: 25 },
      },
    )
    await runner
    expect(payload(result)).toMatchObject({ target: "desktop", state: "done", sessionId: "ses_live", messages: READ_RESULT.messages })
  } finally {
    await cleanup(organizationId)
  }
})
