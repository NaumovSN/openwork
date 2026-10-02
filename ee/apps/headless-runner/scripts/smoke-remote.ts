/**
 * Smoke test against a deployed runner (the Worker on Cloudflare or celld, or the Node server).
 *
 *   HEADLESS_URL=https://<runner> HEADLESS_API_TOKEN=... SMOKE_MODEL_API_KEY=... \
 *   [SMOKE_MCP_TOKEN=...] [SMOKE_MODEL=<alias>] pnpm smoke:remote "Write a haiku to notes/haiku.md"
 *
 * Creates a session, sends one turn with per-turn credentials, polls until it settles, prints the
 * outcome, and deletes the session. Never prints credentials.
 */
import { z } from "zod"

const env = z
  .object({
    HEADLESS_URL: z.url().transform((value) => value.replace(/\/+$/, "")),
    HEADLESS_API_TOKEN: z.string().min(32),
    SMOKE_MODEL_API_KEY: z.string().min(1).optional(),
    SMOKE_MCP_TOKEN: z.string().min(1).optional(),
    SMOKE_MODEL: z.string().min(1).optional(),
  })
  .parse(process.env)
const prompt =
  process.argv.slice(2).join(" ") ||
  "Write a three-line haiku about durable objects to notes/haiku.md with write_file, then reply with the haiku."
const headers = { authorization: `Bearer ${env.HEADLESS_API_TOKEN}`, "content-type": "application/json" }
const call = (path: string, init: RequestInit = {}) =>
  fetch(`${env.HEADLESS_URL}${path}`, { signal: AbortSignal.timeout(30_000), ...init, headers: { ...headers, ...init.headers } })

const started = Date.now()
const health = await fetch(`${env.HEADLESS_URL}/health`)
console.log("health:", health.status, await health.text())
const session = z.object({ id: z.string() }).parse(await (await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "smoke" }) })).json())
console.log("session:", session.id)
const sent = await call(`/v1/sessions/${session.id}/turns`, {
  method: "POST",
  body: JSON.stringify({
    messageId: "msg_smoke",
    prompt,
    ...(env.SMOKE_MODEL ? { model: env.SMOKE_MODEL } : {}),
    credentials: {
      ...(env.SMOKE_MODEL_API_KEY ? { modelApiKey: env.SMOKE_MODEL_API_KEY } : {}),
      ...(env.SMOKE_MCP_TOKEN ? { mcpToken: env.SMOKE_MCP_TOKEN } : {}),
    },
  }),
})
console.log("send:", sent.status, JSON.stringify(z.object({ state: z.string() }).loose().parse(await sent.json()).state))

const snapshot = z.object({
  status: z.enum(["idle", "busy"]),
  turns: z.array(z.object({ status: z.string(), error: z.string().nullable(), usage: z.record(z.string(), z.number()) })),
  messages: z.array(z.object({ role: z.string(), name: z.string().optional(), isError: z.boolean().optional() }).loose()),
  finalAssistantText: z.string(),
})
let view = snapshot.parse(await (await call(`/v1/sessions/${session.id}?outputs=none`)).json())
const deadline = Date.now() + 10 * 60_000
while (view.status === "busy" && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  view = snapshot.parse(await (await call(`/v1/sessions/${session.id}?outputs=none`)).json())
}
const files = z.object({ files: z.array(z.object({ path: z.string(), size: z.number() })) }).parse(await (await call(`/v1/sessions/${session.id}/files`)).json())

console.log("turn:", JSON.stringify(view.turns[0]))
console.log("tools used:", view.messages.filter((m) => m.role === "tool").map((m) => `${m.name}${m.isError ? " (error)" : ""}`))
console.log("files:", JSON.stringify(files.files))
console.log("elapsed ms:", Date.now() - started)
console.log("\n--- answer ---\n" + view.finalAssistantText)
const deleted = await call(`/v1/sessions/${session.id}`, { method: "DELETE" })
console.log("\ndelete:", deleted.status)
process.exit(view.turns[0]?.status === "completed" ? 0 : 1)
