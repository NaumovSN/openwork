/**
 * Load test for a deployed runner (Node server or Worker), meant to run against a runner whose model
 * is a mock with a fixed delay, so the numbers measure the runner and not the model.
 *
 *   HEADLESS_URL=https://<runner> HEADLESS_API_TOKEN=... pnpm bench --label render --levels 1,10,50,100
 *
 * Each level runs that many sessions concurrently, started --ramp ms apart (default 20 ms, so a burst of
 * new connections from one client does not time out). Every session: create, send one turn, poll its
 * status like Den does (every --poll ms, tool outputs left out), then delete. Prints latency
 * percentiles for each API call, the end-to-end turn time seen by the client, and the turn time the
 * runner itself recorded (independent of where this client runs). Never prints the token.
 */
import { Agent, fetch } from "undici"
import { z } from "zod"

const env = z
  .object({ HEADLESS_URL: z.url().transform((value) => value.replace(/\/+$/, "")), HEADLESS_API_TOKEN: z.string().min(32) })
  .parse(process.env)
const flag = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const label = flag("label", new URL(env.HEADLESS_URL).hostname)
const levels = flag("levels", "1,10,50").split(",").map(Number)
const pollMs = Number(flag("poll", "500"))
/** Delay between session starts, so a level opens connections at a steady rate instead of all in one burst. */
const rampMs = Number(flag("ramp", "20"))
const headers = { authorization: `Bearer ${env.HEADLESS_API_TOKEN}`, "content-type": "application/json" }
/**
 * One shared connection pool, like a single den-api process: HTTP/2 where the runner offers it, and at most
 * --connections sockets otherwise. Without it, hundreds of fresh TLS connections from one client time out
 * before they reach the runner.
 */
const dispatcher = new Agent({ allowH2: true, connections: Number(flag("connections", "32")), keepAliveTimeout: 30_000 })

const view = z.object({
  turns: z.array(z.object({ messageId: z.string(), status: z.string(), error: z.string().nullable(), createdAt: z.number(), updatedAt: z.number() })),
})

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now()
  const value = await fn()
  return [value, performance.now() - started]
}

/** Network failures name the request and the low-level cause (for example ECONNRESET), not just "fetch failed". */
async function call(path: string, init: { method?: string; body?: string } = {}) {
  const step = `${init.method ?? "GET"} ${path.replace(/hs_[0-9a-f]+/, ":id").split("?")[0]}`
  try {
    const response = await fetch(`${env.HEADLESS_URL}${path}`, {
      method: init.method,
      body: typeof init.body === "string" ? init.body : undefined,
      headers,
      dispatcher,
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    return { status: response.status, text }
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null
    const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : (cause?.message ?? (error instanceof Error ? error.name : "error"))
    throw new Error(`${step}: ${code}`)
  }
}

type Sample = {
  ok: boolean
  error?: string
  create: number
  send: number
  polls: number[]
  endToEnd: number
  runner: number
}

async function oneSession(index: number): Promise<Sample> {
  const sample: Sample = { ok: false, create: 0, send: 0, polls: [], endToEnd: 0, runner: 0 }
  try {
    const [created, createMs] = await timed(() => call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: `bench ${index}` }) }))
    sample.create = createMs
    if (created.status !== 201) throw new Error(`POST /v1/sessions: ${created.status} ${created.text.slice(0, 80)}`)
    const id = z.object({ id: z.string() }).parse(JSON.parse(created.text)).id
    const started = performance.now()
    const [sent, sendMs] = await timed(() =>
      call(`/v1/sessions/${id}/turns`, { method: "POST", body: JSON.stringify({ messageId: "m1", prompt: "Write a benchmark note." }) }),
    )
    sample.send = sendMs
    if (sent.status !== 202) throw new Error(`POST turns: ${sent.status} ${sent.text.slice(0, 80)}`)
    const deadline = Date.now() + 120_000
    for (;;) {
      const [read, readMs] = await timed(() => call(`/v1/sessions/${id}?messageId=m1&outputs=none`))
      sample.polls.push(readMs)
      if (read.status !== 200) throw new Error(`GET session: ${read.status} ${read.text.slice(0, 80)}`)
      const turn = view.parse(JSON.parse(read.text)).turns.find((entry) => entry.messageId === "m1")
      if (turn && !["queued", "running"].includes(turn.status)) {
        sample.endToEnd = performance.now() - started
        sample.runner = turn.updatedAt - turn.createdAt
        if (turn.status !== "completed") throw new Error(`turn_${turn.status}_${turn.error ?? ""}`)
        break
      }
      if (Date.now() > deadline) throw new Error("turn_timeout")
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    await call(`/v1/sessions/${id}`, { method: "DELETE" })
    sample.ok = true
  } catch (error) {
    sample.error = error instanceof Error ? error.message : String(error)
  }
  return sample
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const ms = (value: number) => (Number.isNaN(value) ? "-" : `${Math.round(value)}`)
const spread = (values: number[]) => `${ms(percentile(values, 50))}/${ms(percentile(values, 95))}/${ms(Math.max(...values))}`

// Warm the deployment (process or isolate) so the first level does not pay a cold start.
await oneSession(-1)

console.log(`runner: ${label}  poll every ${pollMs} ms, a new session every ${rampMs} ms, shared pool  (ms: p50/p95/max)`)
console.log(["sessions", "ok", "failed", "create", "send", "poll", "end-to-end", "runner turn", "turns/s"].join("\t"))
const results: Array<Record<string, unknown>> = []
for (const level of levels) {
  const [samples, wallMs] = await timed(() =>
    Promise.all(
      Array.from({ length: level }, (_, index) =>
        new Promise<void>((resolve) => setTimeout(resolve, index * rampMs)).then(() => oneSession(index)),
      ),
    ),
  )
  const ok = samples.filter((sample) => sample.ok)
  const failures = samples.filter((sample) => !sample.ok).map((sample) => sample.error)
  const row = {
    sessions: level,
    ok: ok.length,
    failed: failures.length,
    create: spread(ok.map((sample) => sample.create)),
    send: spread(ok.map((sample) => sample.send)),
    poll: spread(ok.flatMap((sample) => sample.polls)),
    endToEnd: spread(ok.map((sample) => sample.endToEnd)),
    runnerTurn: spread(ok.map((sample) => sample.runner)),
    turnsPerSecond: (ok.length / (wallMs / 1000)).toFixed(1),
  }
  results.push({ ...row, failures: [...new Set(failures)] })
  const reasons = new Map<string, number>()
  for (const failure of failures) reasons.set(String(failure), (reasons.get(String(failure)) ?? 0) + 1)
  console.log(Object.values(row).join("\t") + (failures.length ? `\t${[...reasons].map(([reason, count]) => `${count}× ${reason}`).join("; ")}` : ""))
}
if (process.argv.includes("--json")) console.log(JSON.stringify({ label, pollMs, results }))
await dispatcher.close()
