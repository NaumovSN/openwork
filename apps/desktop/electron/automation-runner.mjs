import { createHeadlessThreadClient } from "@openwork/headless-threads"

const EMPTY_USAGE = { inputTokens: null, outputTokens: null, costMicros: null }
const RUNNER_WORK_POLL_MS = 60_000
/** Inventory is gathered at most this often; it is sent only when it changed. */
const INVENTORY_MIN_INTERVAL_MS = 2 * 60_000
const INVENTORY_WORKSPACE_LIMIT = 50
const INVENTORY_MODEL_LIMIT = 200
const INVENTORY_REQUEST_TIMEOUT_MS = 10_000
const INVENTORY_CONCURRENCY = 4

function serializedError(value) {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (typeof value?.message === "string") return value.message
  if (typeof value?.data?.message === "string") return value.data.message
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function classifyAutomationExecutionError(error) {
  const raw = serializedError(error)
  if (error?.code === "model_access_lost") {
    return { code: "model_access_lost", message: raw }
  }
  if (/ProviderModelNotFoundError/i.test(raw) || /model\s+not\s+found\s*:/i.test(raw)) {
    const identity = raw.match(/model\s+not\s+found\s*:\s*([^.,}\]"\n]+)/i)?.[1]?.trim()
    return {
      code: "model_access_lost",
      message: identity
        ? `The selected model ${identity} is no longer available. Choose a supported model to resume this Automation.`
        : "The selected model is no longer available. Choose a supported model to resume this Automation.",
    }
  }
  return {
    code: "execution_failed",
    message: raw || "Desktop Automation execution failed",
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error("Automation run cancelled"))
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

async function requestJson(fetchImpl, baseUrl, token, requestPath, options = {}) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${requestPath}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { /* handled below */ }
  if (!response.ok) {
    const error = new Error(String(payload?.message ?? payload?.error ?? `Request returned ${response.status}`))
    Object.defineProperty(error, "status", { value: response.status })
    throw error
  }
  return payload
}

function createWorkspaceSessionClient(local, workspaceId, fetchImpl) {
  return createHeadlessThreadClient({
    baseUrl: local.baseUrl,
    workspaceId,
    token: local.token,
    // Automation run receipts own recovery; desktop restart must not independently
    // resume an occurrence that its scheduler may already have settled or retried.
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set("x-openwork-task-recovery", "off")
      return fetchImpl(input, { ...init, headers })
    },
    requestTimeoutMs: 0,
  })
}

function assistantResult(snapshot) {
  const assistants = Array.isArray(snapshot?.messages)
    ? snapshot.messages.filter((message) => message?.role === "assistant")
    : []
  let resultSummary = null
  let inputTokens = 0
  let outputTokens = 0
  let sawInput = false
  let sawOutput = false
  let sawCompletedTool = false
  for (const message of assistants) {
    const usage = message?.usage
    if (Number.isFinite(usage?.inputTokens)) { inputTokens += Number(usage.inputTokens); sawInput = true }
    if (Number.isFinite(usage?.outputTokens)) { outputTokens += Number(usage.outputTokens); sawOutput = true }
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        resultSummary = part.text.trim().slice(0, 20_000)
      }
      if (part?.type === "tool" && part?.toolStatus === "completed") {
        sawCompletedTool = true
      }
    }
  }
  return {
    resultSummary,
    hasCompletedOutput: Boolean(resultSummary) || sawCompletedTool,
    usage: {
      inputTokens: sawInput ? inputTokens : null,
      outputTokens: sawOutput ? outputTokens : null,
      costMicros: null,
    },
  }
}

function assistantFailure(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "assistant" || !message.error) continue
    return classifyAutomationExecutionError(message.error)
  }
  return null
}

/**
 * Picks the assignment's target workspace.
 *
 * A pinned workspace must exist locally: running the Automation in whatever
 * workspace happens to be active would silently retarget it, which is the
 * exact bug pinning exists to prevent. Unpinned (legacy) assignments keep the
 * historical active-workspace fallback.
 */
export function resolveAssignmentWorkspace(listed, pinnedWorkspaceId) {
  const workspaces = Array.isArray(listed?.items) ? listed.items : []
  if (pinnedWorkspaceId) {
    const pinned = workspaces.find((item) => item?.id === pinnedWorkspaceId)
    if (!pinned?.id) {
      const error = new Error(`The Automation's pinned workspace is not available on this desktop`)
      Object.defineProperty(error, "code", { value: "execution_runtime_unavailable" })
      throw error
    }
    return pinned
  }
  const workspace = workspaces.find((item) => item?.id === listed?.activeId) ?? workspaces[0]
  if (!workspace?.id) throw new Error("No local workspace is available")
  return workspace
}

/**
 * Ids of the workspaces this desktop has, or null when the local runtime
 * cannot say (it is starting, or unreachable).
 */
export async function listLocalWorkspaceIds(options) {
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) return null
  const listed = await requestJson(options.fetchImpl ?? fetch, local.baseUrl, local.token, "/workspaces", { signal: options.signal })
  const items = Array.isArray(listed?.items) ? listed.items : []
  return new Set(items.flatMap((item) => (typeof item?.id === "string" && item.id ? [item.id] : [])))
}

/**
 * Picks the first work item this desktop can run. A member may have many
 * desktops and every one of them sees the same work, so a run pinned to a
 * workspace this desktop lacks is left for the desktop that has it rather
 * than claimed and failed here. Local workspaces are listed only when a pinned
 * item appears; when they cannot be listed, pinned items wait for the next poll.
 */
export async function selectRunnableWorkItem(items, listWorkspaceIds) {
  let workspaceIds
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind === "remote_session_create") {
      if (item.commandId) return item
      continue
    }
    if (!item?.runId) continue
    if (!item.workspaceId) return item
    if (workspaceIds === undefined) workspaceIds = await listWorkspaceIds().catch(() => null)
    if (workspaceIds?.has(item.workspaceId)) return item
  }
  return null
}

/** Runs the assignment as a normal visible local OpenWork thread. */
export async function executeDesktopAutomation(assignment, options) {
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) throw new Error("The desktop runtime is unavailable")
  const localRequest = (requestPath, request = {}) => requestJson(
    options.fetchImpl ?? fetch,
    local.baseUrl,
    local.token,
    requestPath,
    { ...request, signal: options.signal },
  )
  const listed = await localRequest("/workspaces")
  const workspace = resolveAssignmentWorkspace(listed, assignment.workspaceId ?? null)
  const workspaceId = String(workspace.id)
  const client = createWorkspaceSessionClient(local, workspaceId, options.fetchImpl ?? fetch)
  const created = await client.createThread({
    title: `Automation: ${assignment.automationName}`.slice(0, 120),
    ...(assignment.instructions ? { prompt: assignment.instructions } : {}),
    model: assignment.model,
    signal: options.signal,
  })
  const sessionId = created.id
  // The assignment signal is already aborted when this listener runs. Do not
  // pass it to the cleanup request or fetch can reject before reaching OpenCode.
  const abort = () => void client.abortThread(sessionId).catch(() => undefined)
  options.signal.addEventListener("abort", abort, { once: true })
  try {
    const startedAt = Date.now()
    const deadlineAt = startedAt + assignment.timeoutMs
    while (true) {
      if (Date.now() > deadlineAt) throw new Error("Desktop Automation execution timed out")
      // The wall-clock check above only runs between awaits. A machine that
      // suspends mid-request can leave this socket half-open with no error,
      // which would make the assignment timeout unreachable: bound each poll
      // by the remaining execution budget so the deadline always fires.
      const timeoutSignal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))
      let snapshot
      try {
        snapshot = await client.getThreadSnapshot(sessionId, {
          signal: AbortSignal.any([options.signal, timeoutSignal]),
          limit: 200,
        })
      } catch (error) {
        if (!options.signal.aborted && (timeoutSignal.aborted || Date.now() >= deadlineAt)) throw new Error("Desktop Automation execution timed out")
        throw error
      }
      const output = assistantResult(snapshot)
      const snapshotError = assistantFailure(snapshot)
      if (snapshotError) {
        const error = new Error(snapshotError.message)
        Object.defineProperty(error, "code", { value: snapshotError.code })
        throw error
      }
      if (snapshot?.status?.type === "idle" && output.hasCompletedOutput) {
        return {
          sessionId,
          workspaceId,
          resultSummary: output.resultSummary,
          usage: output.usage,
        }
      }
      if (snapshot?.status?.type === "idle" && Date.now() - startedAt > 10_000) {
        throw new Error("Desktop Automation finished without an assistant result")
      }
      await sleep(500, options.signal)
    }
  } catch (error) {
    const contextualError = error instanceof Error ? error : new Error(serializedError(error))
    if (Reflect.get(contextualError, "sessionId") === undefined) {
      Object.defineProperty(contextualError, "sessionId", { value: sessionId })
    }
    if (Reflect.get(contextualError, "workspaceId") === undefined) {
      Object.defineProperty(contextualError, "workspaceId", { value: workspaceId })
    }
    throw contextualError
  } finally {
    options.signal.removeEventListener("abort", abort)
  }
}

function trimmedText(value, limit) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
async function mapBounded(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function modelsFromV1Providers(payload) {
  const providers = Array.isArray(payload?.all) ? payload.all : []
  const connected = Array.isArray(payload?.connected) ? new Set(payload.connected) : null
  const models = []
  for (const provider of providers) {
    const providerId = trimmedText(provider?.id, 160)
    if (!providerId || (connected && !connected.has(providerId))) continue
    const entries = provider?.models && typeof provider.models === "object" ? Object.entries(provider.models) : []
    for (const [key, model] of entries) {
      const modelId = trimmedText(model?.id, 160) ?? trimmedText(key, 160)
      if (!modelId) continue
      models.push({ providerId, modelId, name: trimmedText(model?.name, 200) ?? modelId })
    }
  }
  return models
}

function modelsFromV2Catalog(payload) {
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []
  return items.flatMap((model) => {
    const providerId = trimmedText(model?.providerID, 160)
    const modelId = trimmedText(model?.id, 160)
    if (!providerId || !modelId) return []
    return [{ providerId, modelId, name: trimmedText(model?.name, 200) ?? modelId }]
  })
}

function defaultModelFrom(payload) {
  const model = payload?.model
  const providerId = trimmedText(model?.providerID, 160)
  const modelId = trimmedText(model?.modelID, 160)
  if (!providerId || !modelId) return null
  const variant = trimmedText(model?.variant, 60)
  return { providerId, modelId, ...(variant ? { variant } : {}) }
}

/**
 * What this desktop has for remote-session callers: a friendly computer
 * label and, per workspace, its engine, default model and usable models.
 * Every source is optional: an endpoint this openwork-server lacks (404) or
 * that fails reads as "nothing known" rather than failing the report. Returns
 * null when the local runtime is not up yet.
 */
export async function collectDesktopInventory(options) {
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) return null
  const computer = await options.describeComputer()
  const localRequest = (requestPath) => requestJson(options.fetchImpl ?? fetch, local.baseUrl, local.token, requestPath, {
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(INVENTORY_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(INVENTORY_REQUEST_TIMEOUT_MS),
  })
  const optional = (requestPath) => localRequest(requestPath).catch(() => null)
  const listed = await localRequest("/workspaces")
  const status = await optional("/experimental/engine-v2-preview/status")
  const engine = status?.enabled === true && status?.chatRouting === true ? "v2" : "v1"
  const items = (Array.isArray(listed?.items) ? listed.items : [])
    .filter((item) => typeof item?.id === "string" && item.id)
    .slice(0, INVENTORY_WORKSPACE_LIMIT)
  const workspaces = await mapBounded(items, INVENTORY_CONCURRENCY, async (item) => {
    const base = `/workspace/${encodeURIComponent(item.id)}`
    const [defaults, catalog] = await Promise.all([
      optional(`${base}/default-model`),
      optional(engine === "v2" ? `${base}/opencode2/api/model` : `${base}/opencode/provider`),
    ])
    const models = engine === "v2" ? modelsFromV2Catalog(catalog) : modelsFromV1Providers(catalog)
    return {
      workspaceId: String(item.id).slice(0, 240),
      name: trimmedText(item.displayName, 120) ?? trimmedText(item.name, 120) ?? "Workspace",
      active: item.id === listed?.activeId,
      engine,
      defaultModel: defaultModelFrom(defaults),
      models: models.slice(0, INVENTORY_MODEL_LIMIT),
    }
  })
  return {
    computer: {
      label: trimmedText(computer?.label, 120) ?? "Computer",
      platform: computer.platform,
      appVersion: trimmedText(computer?.appVersion, 80) ?? "unknown",
    },
    workspaces,
  }
}

/**
 * Describes this computer for remote-session callers. macOS has a
 * user-visible computer name (System Settings > General > Sharing); other
 * platforms, and a Mac whose name cannot be read, use the host name.
 */
export function createComputerDescriber(options) {
  return async () => {
    const named = options.platform === "darwin" && options.readComputerName
      ? trimmedText(await options.readComputerName().catch(() => null), 120)
      : null
    let hostname = null
    try { hostname = trimmedText(options.hostname(), 120) } catch { /* unnamed host */ }
    return {
      label: named ?? hostname ?? "Computer",
      platform: options.platform,
      appVersion: options.appVersion,
    }
  }
}

function workspaceUnavailable(workspaceId) {
  const error = new Error(`Workspace ${workspaceId} is not available on this desktop`)
  Object.defineProperty(error, "code", { value: "workspace_unavailable" })
  return error
}

/** Delivers a remote command as a normal visible local OpenWork session. */
export async function executeDesktopRemoteSession(assignment, options) {
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) throw new Error("The desktop runtime is unavailable")
  const localRequest = (requestPath, request = {}) => requestJson(
    options.fetchImpl ?? fetch,
    local.baseUrl,
    local.token,
    requestPath,
    { ...request, signal: options.signal },
  )
  const listed = await localRequest("/workspaces")
  let workspace
  try {
    // The caller's chosen workspace must exist here, exactly like an
    // Automation's pinned workspace; never fall back to the active one.
    workspace = resolveAssignmentWorkspace(listed, assignment.workspaceId ?? null)
  } catch (error) {
    if (assignment.workspaceId) throw workspaceUnavailable(assignment.workspaceId)
    throw error
  }
  const workspaceId = String(workspace.id)
  const client = createWorkspaceSessionClient(local, workspaceId, options.fetchImpl ?? fetch)
  let sessionId = null
  try {
    const created = await client.createThread({
      title: assignment.title,
      ...(assignment.prompt ? { prompt: assignment.prompt } : {}),
      ...(assignment.model ? { model: assignment.model } : {}),
      signal: options.signal,
    })
    sessionId = created.id
    const started = created.started
    return { sessionId, workspaceId, started }
  } catch (error) {
    const contextualError = error instanceof Error ? error : new Error(serializedError(error))
    if (sessionId && Reflect.get(contextualError, "sessionId") === undefined) {
      Object.defineProperty(contextualError, "sessionId", { value: sessionId })
    }
    if (Reflect.get(contextualError, "workspaceId") === undefined) {
      Object.defineProperty(contextualError, "workspaceId", { value: workspaceId })
    }
    throw contextualError
  }
}

/**
 * The runner sends its bearer token to whatever base URL it is configured
 * with, and the configuration arrives over IPC from the renderer. A
 * compromised renderer must not be able to point the token at an arbitrary
 * endpoint: only https origins are accepted, with plain http reserved for
 * loopback development hosts.
 */
export function normalizeRunnerBaseUrl(value) {
  let parsed
  try { parsed = new URL(String(value)) } catch { return null }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)
    || parsed.hostname.endsWith(".localhost")
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null
  if (parsed.username || parsed.password) return null
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "")
}

/**
 * Runner credentials are opaque to the renderer but carry a server-signed
 * audience in their payload. The main process does not need the Den signing
 * key here: changing the audience also changes the token, so a renderer cannot
 * redirect an intact credential without failing this binding check.
 */
function runnerTokenBinding(token) {
  try {
    const [payload, signature, extra] = String(token).split(".")
    if (!payload || !signature || extra) return null
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    const scope = [decoded?.o, decoded?.m, decoded?.r].every((value) => typeof value === "string")
      ? `${decoded.o}\n${decoded.m}\n${decoded.r}`
      : null
    if (decoded?.v === 1) return { version: 1, audience: null, scope }
    if (decoded?.v !== 2 || typeof decoded.a !== "string") return null
    const audience = normalizeRunnerBaseUrl(decoded.a)
    return audience ? { version: 2, audience, scope } : null
  } catch {
    return null
  }
}

export function runnerTokenAudience(token) {
  return runnerTokenBinding(token)?.audience ?? null
}

export function createDesktopAutomationRunner(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const random = options.random ?? Math.random
  const waitBeforeReconnect = options.waitBeforeReconnect ?? sleep
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 8_000
  const heartbeatMissLimit = options.heartbeatMissLimit ?? 3
  const workPollTimeoutMs = options.workPollTimeoutMs ?? 30_000
  const lifecycleRequestTimeoutMs = options.lifecycleRequestTimeoutMs ?? 30_000
  const legacyBaseUrls = new Set((options.legacyBaseUrls ?? [])
    .map((value) => normalizeRunnerBaseUrl(value))
    .filter(Boolean))
  let generation = 0
  let current = null
  let pendingConfiguration = null
  let stopped = false
  const rejectedCredentials = new Set()

  const inventoryMinIntervalMs = options.inventoryMinIntervalMs ?? INVENTORY_MIN_INTERVAL_MS
  const now = options.now ?? Date.now

  /**
   * Tells Den what this desktop has, so remote-session callers can choose a
   * computer, workspace and model. Sent once per credential (registration)
   * and then only when it changed, gathered at most once per interval. Den
   * versions without the endpoint answer 404 and are not asked again under
   * this credential. A failure never affects polling for work.
   */
  const reportInventory = (state) => {
    if (!options.describeComputer || state.inventoryUnsupported || state.inventoryInFlight || !isCurrent(state)) return
    if (state.inventoryCheckedAt !== null && now() - state.inventoryCheckedAt < inventoryMinIntervalMs) return
    state.inventoryCheckedAt = now()
    state.inventoryInFlight = (async () => {
      try {
        const inventory = await collectDesktopInventory({
          getLocalRuntime: options.getLocalRuntime,
          describeComputer: options.describeComputer,
          fetchImpl,
          signal: state.controller.signal,
        })
        if (!inventory || !isCurrent(state)) {
          // The local runtime is still starting: try again on the next poll.
          if (!inventory) state.inventoryCheckedAt = null
          return
        }
        const key = JSON.stringify(inventory)
        if (key === state.inventoryKey) return
        await runnerRequest(state, "/v1/automation-runner/inventory", {
          method: "PUT",
          body: inventory,
          signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
        })
        state.inventoryKey = key
      } catch (error) {
        if (error?.status === 404) state.inventoryUnsupported = true
        else options.log?.(`runner inventory report failed: ${serializedError(error)}`)
      } finally {
        state.inventoryInFlight = null
        options.onInventoryReported?.()
      }
    })()
  }

  const credentialKey = (configuration) => `${configuration.baseUrl}\n${configuration.token}`
  const isCurrent = (state) => !stopped
    && current === state
    && current.generation === state.generation
    && !state.retired
  const retire = (state, reason) => {
    if (state.retired) return
    state.retired = true
    state.controller.abort(reason)
    state.active?.controller.abort(reason)
    if (current === state) current = null
  }

  const rejectCredential = (state, status) => {
    if (state.credentialRejected) return
    state.credentialRejected = true
    const key = credentialKey(state.configuration)
    rejectedCredentials.add(key)
    const affectedCurrent = current === state || (current && credentialKey(current.configuration) === key)
      ? current
      : null
    retire(state, new Error(`Automation runner credential rejected with HTTP ${status}`))
    if (affectedCurrent && affectedCurrent !== state) {
      affectedCurrent.credentialRejected = true
      retire(affectedCurrent, new Error(`Automation runner credential rejected with HTTP ${status}`))
    }
    if (pendingConfiguration && credentialKey(pendingConfiguration) === key) pendingConfiguration = null
    options.log?.(`runner credential rejected with HTTP ${status}`)
    if (affectedCurrent) options.onCredentialRejected?.()
    if (affectedCurrent && pendingConfiguration) {
      const next = pendingConfiguration
      pendingConfiguration = null
      activateConfiguration(next)
    }
  }

  const runnerRequest = async (state, requestPath, request = {}) => {
    if (!isCurrent(state)) {
      throw state.controller.signal.reason ?? new Error("Automation runner generation retired")
    }
    try {
      return await requestJson(
        fetchImpl,
        state.configuration.baseUrl,
        state.configuration.token,
        requestPath,
        {
          ...request,
          signal: request.signal
            ? AbortSignal.any([state.controller.signal, request.signal])
            : state.controller.signal,
        },
      )
    } catch (error) {
      if ([401, 403].includes(error?.status)) rejectCredential(state, error.status)
      throw error
    }
  }

  const heartbeat = async (state, active) => {
    if (state.active !== active || !isCurrent(state)) return
    const response = await runnerRequest(
      state,
      `/v1/automation-runs/${encodeURIComponent(active.assignment.runId)}/heartbeat`,
      {
        method: "POST",
        body: { attempt: active.assignment.attempt },
        // Bounded below the interval so a hung probe settles before the next
        // one is due instead of pinning the lease refresh on a dead socket.
        signal: AbortSignal.timeout(heartbeatTimeoutMs),
      },
    )
    if (state.active === active && (response.cancelRequested || response.leaseValid !== true)) {
      active.controller.abort(new Error("Automation run cancelled or lease lost"))
    }
  }

  let activateConfiguration

  const runAssignment = async (state, assignment) => {
    const controller = new AbortController()
    const active = { assignment, controller }
    state.active = active
    let sequence = 0
    const event = (type, payload) => runnerRequest(
      state,
      `/v1/automation-runs/${encodeURIComponent(assignment.runId)}/events`,
      {
        method: "POST",
        body: { attempt: assignment.attempt, sequence: ++sequence, type, payload, createdAt: Date.now() },
        signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
      },
    )
    // Self-scheduling instead of setInterval: the next probe is armed only
    // after the current one settles, so a slow heartbeat can never overlap
    // the next tick. One transient failure must not kill a healthy run, so
    // the run aborts only after consecutive misses outlast the lease.
    let heartbeatTimer = null
    let heartbeatStopped = false
    let heartbeatMisses = 0
    const heartbeatTick = async () => {
      try {
        await heartbeat(state, active)
        heartbeatMisses = 0
      } catch (error) {
        heartbeatMisses += 1
        if (heartbeatMisses >= heartbeatMissLimit) {
          controller.abort(new Error(`Automation run heartbeat failed ${heartbeatMisses} times: ${serializedError(error)}`))
          return
        }
        options.log?.(`runner heartbeat missed (${heartbeatMisses}/${heartbeatMissLimit}): ${serializedError(error)}`)
      }
      if (!heartbeatStopped && state.active === active && !controller.signal.aborted) scheduleHeartbeat()
    }
    const scheduleHeartbeat = () => {
      heartbeatTimer = setTimeout(() => void heartbeatTick(), heartbeatIntervalMs)
    }
    scheduleHeartbeat()
    let result
    try {
      await event("user", { text: assignment.instructions, executionTarget: "desktop" })
      const output = await executeDesktopAutomation(assignment, {
        getLocalRuntime: options.getLocalRuntime,
        fetchImpl,
        signal: controller.signal,
      })
      if (output.resultSummary) await event("assistant", {
        text: output.resultSummary,
        sessionId: output.sessionId,
        workspaceId: output.workspaceId,
      })
      await event("usage", output.usage)
      result = { status: "succeeded", ...output, error: null }
    } catch (error) {
      const cancelled = controller.signal.aborted && String(controller.signal.reason).toLowerCase().includes("cancel")
      const classified = classifyAutomationExecutionError(error)
      result = {
        status: cancelled ? "cancelled" : "failed",
        sessionId: typeof error?.sessionId === "string" ? error.sessionId : null,
        workspaceId: typeof error?.workspaceId === "string" ? error.workspaceId : null,
        resultSummary: null,
        usage: EMPTY_USAGE,
        error: {
          code: cancelled ? "cancelled" : classified.code,
          message: cancelled
            ? (error instanceof Error ? error.message : "Automation run cancelled")
            : classified.message,
          retryable: false,
        },
      }
    } finally {
      heartbeatStopped = true
      clearTimeout(heartbeatTimer)
    }
    // Terminal delivery must terminate: reconcile (and with it the whole
    // runner) waits on this step, so a hung or transiently failing request
    // here would otherwise wedge the desktop until the app restarts. Each
    // request gets its own deadline plus one retry, and a failed terminal
    // event never skips the completion POST.
    const deliver = async (label, send) => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await send()
          return
        } catch (error) {
          const retry = attempt === 1 && isCurrent(state)
          options.log?.(`runner ${label} delivery failed${retry ? ", retrying" : ""}: ${serializedError(error)}`)
          if (!retry) return
        }
      }
    }
    try {
      await deliver("terminal event", () => event("terminal", {
        status: result.status,
        executionTarget: "desktop",
        sessionId: result.sessionId,
      }))
      await deliver("completion", () => runnerRequest(state, `/v1/automation-runs/${encodeURIComponent(assignment.runId)}/complete`, {
        method: "POST",
        body: { ...result, attempt: assignment.attempt },
        signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
      }))
    } finally {
      if (state.active === active) state.active = null
      if (isCurrent(state) && pendingConfiguration) {
        const next = pendingConfiguration
        pendingConfiguration = null
        activateConfiguration(next)
      }
    }
  }

  const runRemoteSessionCommand = async (state, assignment) => {
    const controller = new AbortController()
    const active = { assignment, controller }
    state.active = active
    let result
    try {
      const output = await executeDesktopRemoteSession(assignment, {
        getLocalRuntime: options.getLocalRuntime,
        fetchImpl,
        signal: controller.signal,
      })
      result = {
        status: "delivered",
        sessionId: output.sessionId,
        workspaceId: output.workspaceId,
        resultSummary: "Remote session created",
      }
    } catch (error) {
      result = {
        status: "failed",
        error: {
          code: error?.code === "workspace_unavailable" ? "workspace_unavailable" : "execution_failed",
          message: (serializedError(error) || "Remote session creation failed").slice(0, 2_000),
        },
      }
    }
    try {
      await runnerRequest(state, `/v1/remote-session-commands/${encodeURIComponent(assignment.commandId)}/complete`, {
        method: "POST",
        body: result,
        signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
      })
    } finally {
      if (state.active === active) state.active = null
      if (isCurrent(state) && pendingConfiguration) {
        const next = pendingConfiguration
        pendingConfiguration = null
        activateConfiguration(next)
      }
    }
  }

  const reconcile = (state) => {
    if (!isCurrent(state)) return Promise.resolve()
    if (state.reconcilePromise) return state.reconcilePromise
    const promise = (async () => {
      while (isCurrent(state)) {
        // A machine that suspends mid-request can leave this socket half-open
        // with no error, which would park the loop until the process restarts.
        // Bounding the idle poll turns that into an ordinary retry.
        const response = await runnerRequest(state, "/v1/automation-runner/work", {
          signal: AbortSignal.timeout(workPollTimeoutMs),
        })
        if (!isCurrent(state)) break
        const item = await selectRunnableWorkItem(response?.items, () => listLocalWorkspaceIds({
          getLocalRuntime: options.getLocalRuntime,
          fetchImpl,
          signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(workPollTimeoutMs)]),
        }))
        if (!isCurrent(state) || !item) break
        if (item.kind === "remote_session_create") {
          state.claimInFlight = true
          let claimed
          try {
            claimed = await runnerRequest(
              state,
              `/v1/remote-session-commands/${encodeURIComponent(item.commandId)}/claim`,
              { method: "POST", body: {}, signal: AbortSignal.timeout(lifecycleRequestTimeoutMs) },
            )
          } catch (error) {
            if (error?.status === 409) continue
            throw error
          } finally {
            state.claimInFlight = false
          }
          if (!claimed?.assignment) break
          await runRemoteSessionCommand(state, claimed.assignment)
          continue
        }
        state.claimInFlight = true
        let claimed
        try {
          claimed = await runnerRequest(state, `/v1/automation-runs/${encodeURIComponent(item.runId)}/claim`, {
            method: "POST",
            body: {},
            signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
          })
        } finally {
          state.claimInFlight = false
        }
        if (!claimed?.assignment) break
        await runAssignment(state, claimed.assignment)
      }
    })().finally(() => {
      if (state.reconcilePromise === promise) state.reconcilePromise = null
      if (isCurrent(state) && pendingConfiguration && !state.active) {
        const next = pendingConfiguration
        pendingConfiguration = null
        activateConfiguration(next)
      }
    })
    state.reconcilePromise = promise
    return promise
  }

  const connectLoop = async (state) => {
    let reconnectAttempt = 0
    while (isCurrent(state)) {
      reportInventory(state)
      try {
        await reconcile(state)
        reconnectAttempt = 0
        await waitBeforeReconnect(RUNNER_WORK_POLL_MS, state.controller.signal)
      } catch (error) {
        if (!isCurrent(state)) return
        if ([401, 403].includes(error?.status)) return
        options.log?.(`runner polling failed: ${error instanceof Error ? error.message : String(error)}`)
        const backoff = Math.min(30_000, 500 * (2 ** reconnectAttempt++))
        try {
          await waitBeforeReconnect(Math.round(backoff * (0.5 + random())), state.controller.signal)
        } catch (waitError) {
          if (!isCurrent(state)) return
          options.log?.(`runner polling wait failed: ${waitError instanceof Error ? waitError.message : String(waitError)}`)
        }
      }
    }
  }

  activateConfiguration = (configuration) => {
    const previous = current
    generation += 1
    if (previous) retire(previous, new Error("Automation runner configuration changed"))
    if (!configuration || stopped) return
    const state = {
      generation,
      configuration,
      controller: new AbortController(),
      reconcilePromise: null,
      claimInFlight: false,
      active: null,
      retired: false,
      credentialRejected: false,
      inventoryKey: null,
      inventoryCheckedAt: null,
      inventoryInFlight: null,
      inventoryUnsupported: false,
    }
    current = state
    void connectLoop(state)
  }

  return {
    configure(next) {
      const baseUrl = next ? normalizeRunnerBaseUrl(next.baseUrl) : null
      const token = next?.token ? String(next.token) : ""
      const binding = token ? runnerTokenBinding(token) : null
      const destinationAllowed = baseUrl && (
        (binding?.version === 2 && binding.audience === baseUrl)
        || (binding?.version === 1 && legacyBaseUrls.has(baseUrl))
      )
      const normalized = destinationAllowed && token && next?.runnerId
        ? { baseUrl, token, runnerId: String(next.runnerId) }
        : null
      if (next && !normalized) {
        // Without this the desktop stays quiet while every scheduled run is
        // recorded as missed, which reads as a scheduler fault rather than a
        // credential bound to a different Den route than this desktop uses.
        options.log?.(`rejected runner credential for ${baseUrl ?? "an unusable base URL"}`
          + `: token audience ${binding?.audience ?? (binding ? "v1 (untrusted here)" : "unreadable")}`)
      }
      if (normalized && rejectedCredentials.has(credentialKey(normalized))) {
        return { connected: false }
      }
      if (
        normalized
        && current?.configuration.baseUrl === normalized.baseUrl
        && current.configuration.token === normalized.token
      ) {
        pendingConfiguration = null
        return { connected: !current.controller.signal.aborted }
      }
      if (normalized && (current?.active || current?.claimInFlight)) {
        pendingConfiguration = normalized
        return { connected: !current.controller.signal.aborted }
      }
      pendingConfiguration = null
      activateConfiguration(normalized)
      return { connected: false }
    },
    /**
     * A sleeping machine parks the loop mid-wait, so a due occurrence can sit
     * queued for most of a poll interval after the desktop is already back.
     * Waking the machine polls for work now. The reconcile guard reuses an
     * in-flight cycle, so a run already holding its lease is left alone and no
     * second claim loop starts.
     */
    wake() {
      const state = current
      if (stopped || !state || !isCurrent(state)) return { polled: false }
      reportInventory(state)
      reconcile(state).catch((error) => {
        options.log?.(`runner wake poll failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return { polled: true }
    },
    stop() {
      stopped = true
      generation += 1
      pendingConfiguration = null
      if (current) retire(current, new Error("Desktop is shutting down"))
    },
  }
}
