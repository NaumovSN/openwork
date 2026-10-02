/**
 * The headless runner as a Worker: one Durable Object per session instead of one Node process with
 * one SQLite file. Runs unchanged on Cloudflare Workers and on celld (self-hosted Workers and Durable
 * Objects on an S3 bucket). The HTTP API is the Node server's, so callers do not change.
 *
 *   caller ─► Worker (auth, routing) ─► HeadlessSession "hs_…" (Store + Runner + its own SQLite)
 *
 * The session's Durable Object runs the same Runner as the Node server. A turn keeps the object in
 * memory while its model and MCP requests are in flight. If the object restarts mid-turn (a deploy,
 * a node loss), its next request marks the turn interrupted, exactly as a Node restart does, and the
 * caller resumes it by re-sending the same messageId with fresh credentials.
 */
import { DurableObject } from "cloudflare:workers"
import { Hono, type Context } from "hono"
import { createApp } from "../app.js"
import { bearerAuth } from "../auth.js"
import { loadConfig, type Config } from "../config.js"
import { createRunner, gatewayModelCatalog } from "../runtime.js"
import { Store } from "../store.js"
import { durableObjectSql } from "./sql.js"

export type Env = {
  HEADLESS_SESSION: DurableObjectNamespace<HeadlessSession>
  [name: string]: unknown
}

const SESSION_ID = /^hs_[0-9a-f]{32}$/
/** Set only by the Worker. The object checks it against its own id, so a wrong value cannot reach another session. */
const SESSION_HEADER = "x-openwork-headless-session"

const configs = new WeakMap<object, Config>()
/** Parses the `HEADLESS_*` vars and secrets once per env object. */
function configFor(env: Env): Config {
  const cached = configs.get(env)
  if (cached) return cached
  const vars = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  const config = loadConfig(vars)
  configs.set(env, config)
  return config
}

export class HeadlessSession extends DurableObject<Env> {
  private readonly store: Store
  private readonly app: Hono
  private sessionId: string | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const config = configFor(env)
    this.store = new Store(durableObjectSql(ctx.storage), {
      sessionId: () => {
        if (!this.sessionId) throw new Error("session_id_missing")
        return this.sessionId
      },
    })
    // A new instance is a new process: a turn left queued or running lost its in-memory credentials.
    const recovered = this.store.recoverInterruptedTurns()
    if (recovered) console.log(`[headless-runner] ${recovered} interrupted turn(s) recovered`)
    this.app = createApp({ store: this.store, runner: createRunner(config, this.store), apiToken: config.apiToken })
  }

  async fetch(request: Request) {
    const name = request.headers.get(SESSION_HEADER) ?? ""
    if (!SESSION_ID.test(name) || !this.ctx.id.equals(this.env.HEADLESS_SESSION.idFromName(name))) {
      return Response.json({ error: "unknown_session" }, { status: 404 })
    }
    this.sessionId = name
    const response = await this.app.fetch(request)
    if (request.method === "DELETE" && response.status === 204) {
      // Nothing is left in this object; drop its storage and keep the empty tables usable.
      await this.ctx.storage.deleteAll()
      this.store.migrate()
    }
    return response
  }
}

const models = new WeakMap<Config, ReturnType<typeof gatewayModelCatalog>>()

function forward(env: Env, request: Request, sessionId: string) {
  const headers = new Headers(request.headers)
  headers.set(SESSION_HEADER, sessionId)
  const stub = env.HEADLESS_SESSION.get(env.HEADLESS_SESSION.idFromName(sessionId))
  return stub.fetch(new Request(request, { headers }))
}

const router = new Hono<{ Bindings: Env }>()

router.get("/health", (c) => c.json({ ok: true }))
router.use("/v1/*", bearerAuth((c) => configFor(c.env).apiToken))
router.onError((error, c) => {
  console.error("[headless-runner] request failed", { path: c.req.path, error: error.message })
  return c.json({ error: "internal_error" }, 500)
})

router.get("/v1/models", async (c) => {
  const config = configFor(c.env)
  let catalog = models.get(config)
  if (!catalog) {
    catalog = gatewayModelCatalog(config)
    models.set(config, catalog)
  }
  return c.json(await catalog())
})

router.post("/v1/sessions", (c) => forward(c.env, c.req.raw, `hs_${crypto.randomUUID().replaceAll("-", "")}`))

const session = (c: Context<{ Bindings: Env }>) => {
  const id = c.req.param("id") ?? ""
  if (!SESSION_ID.test(id)) return c.json({ error: "unknown_session" }, 404)
  return forward(c.env, c.req.raw, id)
}
router.all("/v1/sessions/:id", session)
router.all("/v1/sessions/:id/*", session)

export default router
