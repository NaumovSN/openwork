/**
 * End-to-end check of the Worker build (src/worker), in local workerd through `wrangler dev`, or in
 * celld (self-hosted Workers and Durable Objects) through `celld dev`.
 *
 *   pnpm worker:e2e          # wrangler dev
 *   pnpm worker:e2e:celld    # celld dev; needs celld on PATH (https://celld.dev) or CELLD_BIN
 *
 * A mock OpenAI-compatible model on loopback answers each turn with one write_file call and then a
 * short reply. The script checks the HTTP API, per-turn credentials, idempotent sends, and that a
 * turn cut off by a runtime restart is reported as interrupted and then resumes to completion with
 * the same messageId. Durable Object state persists across the restart in a temporary directory.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const WRANGLER = "wrangler@4.142.0"
const RUNTIME = process.argv.includes("--celld") ? "celld" : "wrangler"
const PROJECT = join(import.meta.dirname, "..")
const API_TOKEN = `e2e_${crypto.randomUUID().replaceAll("-", "")}`
const TURN_KEY = "turn-key-e2e"
const DEFAULT_KEY = "default-key-e2e"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))))
    })
  })
}

// ------------------------------------------------------------- mock model

const chatRequest = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).loose()),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
})
let lastToolNames: string[] = []
const seenKeys: string[] = []
let slowCalls = 0
const hanging: ServerResponse[] = []

type ChatMessages = z.infer<typeof chatRequest>["messages"]

/** The current turn: its prompt (the last user message) and whether a tool result followed it. */
function currentTurn(messages: ChatMessages) {
  const index = messages.findLastIndex((message) => message.role === "user")
  const content = messages[index]?.content
  return {
    prompt: typeof content === "string" ? content : "",
    answered: messages.slice(index + 1).some((message) => message.role === "tool"),
  }
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString("utf8")
}

const model = createServer(async (request, response) => {
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  }
  if (request.method === "GET" && request.url === "/models") return json(200, { data: [{ id: "gwm_e2e", name: "E2E model (group / creds)" }] })
  if (request.method !== "POST" || request.url !== "/chat/completions") return json(404, { error: "not_found" })
  seenKeys.push(request.headers.authorization ?? "")
  const body = chatRequest.parse(JSON.parse(await readBody(request)))
  const { prompt, answered } = currentTurn(body.messages)
  const note = /note-\d+/.exec(prompt)?.[0] ?? "note"
  // The first call of a "[slow]" turn never answers, so the runtime can be restarted mid-turn.
  if (prompt.includes("[slow]") && !answered && slowCalls++ === 0) {
    hanging.push(response)
    return
  }
  const usage = { prompt_tokens: 50, completion_tokens: 10 }
  if (prompt.includes("[mcp]")) {
    lastToolNames = body.tools?.map((tool) => tool.function.name) ?? []
    if (answered) return json(200, { choices: [{ message: { content: "It is sunny in Paris." } }], usage })
    return json(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call_weather", type: "function", function: { name: "lookup_weather", arguments: JSON.stringify({ city: "Paris" }) } }],
          },
        },
      ],
      usage,
    })
  }
  if (!answered) {
    return json(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: `call_${note}`,
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: `notes/${note}.md`, content: `hello from ${note}` }) },
              },
            ],
          },
        },
      ],
      usage,
    })
  }
  return json(200, { choices: [{ message: { content: `Saved notes/${note}.md.` } }], usage })
})

// --------------------------------------------------------------- mock MCP

const MCP_TOKEN = "mcp-token-e2e"
const mcpCalls: Array<{ authorization: string; name: string; city: string }> = []
const rpcMessage = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() })

/** A minimal streamable-HTTP MCP server with one tool, answering in plain JSON (no SSE). */
const mcp = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.writeHead(405).end()
    return
  }
  if (request.method === "DELETE") {
    response.writeHead(200).end()
    return
  }
  const message = rpcMessage.parse(JSON.parse(await readBody(request)))
  if (message.id === undefined) {
    response.writeHead(202).end()
    return
  }
  const reply = (body: Record<string, unknown>) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }))
  }
  if (message.method === "initialize") {
    return reply({
      result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "e2e-mcp", version: "1.0.0" } },
    })
  }
  if (message.method === "tools/list") {
    return reply({
      result: {
        tools: [
          {
            name: "lookup_weather",
            description: "Current weather for a city",
            inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        ],
      },
    })
  }
  if (message.method === "tools/call") {
    const args = z.object({ arguments: z.object({ city: z.string() }) }).parse(message.params)
    mcpCalls.push({ authorization: request.headers.authorization ?? "", name: String(message.params?.name), city: args.arguments.city })
    return reply({ result: { content: [{ type: "text", text: `sunny in ${args.arguments.city}` }] } })
  }
  return reply({ error: { code: -32601, message: `Method not found: ${message.method}` } })
})

// ----------------------------------------------------------- wrangler dev

const persistDir = mkdtempSync(join(tmpdir(), "headless-worker-e2e-"))
let worker: ChildProcess | null = null
let restarts = 0
let workerOutput = ""
let base = ""

async function startWorker(modelPort: number, mcpPort: number) {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  const vars = {
    HEADLESS_API_TOKEN: API_TOKEN,
    HEADLESS_MODEL_PROTOCOL: "openai",
    HEADLESS_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}`,
    HEADLESS_MODEL: "gwm_e2e",
    HEADLESS_MODEL_API_KEY: DEFAULT_KEY,
    HEADLESS_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`,
  }
  if (RUNTIME === "celld") {
    // celld dev reads Worker vars from .dev.vars and keeps state in .celld/dev, both beside the config.
    writeFileSync(join(PROJECT, ".dev.vars"), Object.entries(vars).map(([name, value]) => `${name}=${value}\n`).join(""))
    const args = ["dev", ".", "--host", "127.0.0.1", "--port", String(port), "--no-watch", ...(restarts === 0 ? ["--clean"] : [])]
    // celld bundles with esbuild; use the package's pinned one.
    const env = { ...process.env, CELLD_ESBUILD: process.env.CELLD_ESBUILD ?? join(PROJECT, "node_modules", ".bin", "esbuild") }
    worker = spawn(process.env.CELLD_BIN ?? "celld", args, { cwd: PROJECT, detached: true, stdio: ["ignore", "pipe", "pipe"], env })
  } else {
    const args = ["dlx", WRANGLER, "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistDir, "--show-interactive-dev-session=false"]
    for (const [name, value] of Object.entries(vars)) args.push("--var", `${name}:${value}`)
    // Its own process group, so a restart can kill wrangler and its workerd child together.
    worker = spawn("pnpm", args, { cwd: PROJECT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } })
  }
  restarts += 1
  let output = ""
  const collect = (chunk: unknown) => {
    output += String(chunk)
    workerOutput += String(chunk)
  }
  worker.stdout?.on("data", collect)
  worker.stderr?.on("data", collect)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`${RUNTIME} dev exited early:\n${output}`)
    const ok = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.ok, () => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${RUNTIME} dev did not become healthy:\n${output}`)
}

async function stopWorker() {
  const child = worker
  worker = null
  if (!child?.pid) return
  const exited = new Promise((resolve) => {
    child.once("exit", resolve)
    setTimeout(resolve, 10_000)
  })
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    // already gone
  }
  await exited
}

// ------------------------------------------------------------------ checks

const headers = { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" }
const sessionView = z.object({
  status: z.enum(["idle", "busy"]),
  turns: z.array(z.object({ messageId: z.string(), status: z.string(), error: z.string().nullable() })),
  finalAssistantText: z.string(),
})

async function call(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000), ...init, headers: { ...headers, ...init.headers } })
}

async function view(sessionId: string) {
  return sessionView.parse(await (await call(`/v1/sessions/${sessionId}`)).json())
}

async function until(sessionId: string, done: (value: z.infer<typeof sessionView>) => boolean, label: string) {
  const deadline = Date.now() + 30_000
  let last: z.infer<typeof sessionView> | null = null
  while (Date.now() < deadline) {
    last = await view(sessionId)
    if (done(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`)
}

function send(sessionId: string, messageId: string, prompt: string) {
  return call(`/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({ messageId, prompt, credentials: { modelApiKey: TURN_KEY } }),
  })
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
  if (!ok) failures += 1
}

await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", () => resolve()))
const modelAddress = model.address()
const modelPort = typeof modelAddress === "object" && modelAddress ? modelAddress.port : 0
await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", () => resolve()))
const mcpAddress = mcp.address()
const mcpPort = typeof mcpAddress === "object" && mcpAddress ? mcpAddress.port : 0

try {
  await startWorker(modelPort, mcpPort)
  check("health answers without a token", (await fetch(`${base}/health`)).ok)
  check("/v1 routes require the service token", (await fetch(`${base}/v1/models`)).status === 401)
  const catalog = z.object({ models: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(await (await call("/v1/models")).json())
  check("models come from the Gateway route", catalog.models.some((entry) => entry.id === "gwm_e2e" && entry.name === "E2E model"), catalog)

  const created = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "e2e" }) })
  const session = z.object({ id: z.string().regex(/^hs_[0-9a-f]{32}$/), title: z.string() }).parse(await created.json())
  check("creating a session returns 201 with an hs_ id", created.status === 201 && session.title === "e2e")
  check("a malformed session id is unknown", (await call("/v1/sessions/not-a-session")).status === 404)
  check("a well-formed id that was never created is unknown", (await call(`/v1/sessions/hs_${"0".repeat(32)}`)).status === 404)

  const sent = await send(session.id, "msg_1", "Write note-1 please")
  check("a turn is accepted with 202", sent.status === 202)
  const first = await until(session.id, (value) => value.status === "idle", "msg_1 to finish")
  check("the turn completes", first.turns[0]?.status === "completed", first.turns)
  check("the final answer is returned", first.finalAssistantText === "Saved notes/note-1.md.", first.finalAssistantText)
  const file = await call(`/v1/sessions/${session.id}/files/content?path=notes/note-1.md`)
  check("the tool call wrote a file in the session", file.status === 200 && (await file.text()) === "hello from note-1")
  check("the model was called with the turn's own key", seenKeys.length === 2 && seenKeys.every((key) => key === `Bearer ${TURN_KEY}`), seenKeys)
  const again = z.object({ state: z.string() }).parse(await (await send(session.id, "msg_1", "Write note-1 please")).json())
  check("re-sending a finished messageId is idempotent", again.state === "already_present", again)

  // An OpenWork MCP tool, reached with the turn's own MCP token.
  await call(`/v1/sessions/${session.id}/turns`, {
    method: "POST",
    body: JSON.stringify({ messageId: "msg_mcp", prompt: "[mcp] What is the weather in Paris?", credentials: { modelApiKey: TURN_KEY, mcpToken: MCP_TOKEN } }),
  })
  const weather = await until(session.id, (value) => value.status === "idle", "msg_mcp to finish")
  check("an MCP turn completes", weather.turns.find((turn) => turn.messageId === "msg_mcp")?.status === "completed", weather.turns)
  check("the model was offered the MCP tool next to the file tools", lastToolNames.includes("lookup_weather") && lastToolNames.includes("write_file"), lastToolNames)
  check("the MCP tool ran once with the turn's MCP token", mcpCalls.length === 1 && mcpCalls[0]?.authorization === `Bearer ${MCP_TOKEN}` && mcpCalls[0]?.city === "Paris", mcpCalls)
  check("the MCP answer reached the reply", weather.finalAssistantText === "It is sunny in Paris.", weather.finalAssistantText)

  // A restart mid-turn: the object loses its in-memory credentials; the caller resumes.
  await send(session.id, "msg_2", "[slow] Write note-2 please")
  const deadline = Date.now() + 15_000
  while (hanging.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  check("the slow turn reached the model", hanging.length === 1)
  check("the session is busy while the model call is in flight", (await view(session.id)).status === "busy")
  await stopWorker()
  for (const response of hanging.splice(0)) response.destroy()
  await startWorker(modelPort, mcpPort)
  const interrupted = await view(session.id)
  const cut = interrupted.turns.find((turn) => turn.messageId === "msg_2")
  check("after the restart the cut-off turn is interrupted, not stuck running", cut?.status === "interrupted" && cut.error === "runner_restarted", cut)
  const resumed = z.object({ state: z.string() }).parse(await (await send(session.id, "msg_2", "[slow] Write note-2 please")).json())
  check("re-sending the same messageId resumes it", resumed.state === "resumed", resumed)
  const second = await until(session.id, (value) => value.status === "idle", "msg_2 to finish")
  check("the resumed turn completes", second.turns.find((turn) => turn.messageId === "msg_2")?.status === "completed", second.turns)
  check("files from before the restart are still there", (await call(`/v1/sessions/${session.id}/files/content?path=notes/note-1.md`)).status === 200)
  check("the resumed turn wrote its file", (await call(`/v1/sessions/${session.id}/files/content?path=notes/note-2.md`)).status === 200)

  check("deleting the session returns 204", (await call(`/v1/sessions/${session.id}`, { method: "DELETE" })).status === 204)
  check("a deleted session is unknown", (await call(`/v1/sessions/${session.id}`)).status === 404)
} catch (error) {
  failures += 1
  console.error(error)
} finally {
  await stopWorker()
  model.close()
  mcp.close()
  rmSync(persistDir, { recursive: true, force: true })
  if (RUNTIME === "celld") {
    rmSync(join(PROJECT, ".dev.vars"), { force: true })
    rmSync(join(PROJECT, ".celld"), { recursive: true, force: true })
  }
}

if (failures) console.log(`\n--- ${RUNTIME} dev output (last 4000 chars) ---\n${workerOutput.slice(-4000)}`)
console.log(failures ? `\n${failures} check(s) failed on ${RUNTIME}` : `\nall checks passed on ${RUNTIME}`)
process.exit(failures ? 1 : 0)
