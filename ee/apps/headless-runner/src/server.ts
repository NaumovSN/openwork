import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { loadConfig } from "./config.js"
import { nodeSqlite } from "./node-sqlite.js"
import { createRunner, gatewayModelCatalog } from "./runtime.js"
import { Store } from "./store.js"

const config = loadConfig()
const store = new Store(nodeSqlite(config.dbPath))
const recovered = store.recoverInterruptedTurns()
const runner = createRunner(config, store)
const models = gatewayModelCatalog(config)

const server = serve({ fetch: createApp({ store, runner, apiToken: config.apiToken, models }).fetch, port: config.port }, (info) => {
  console.log(`[headless-runner] listening on :${info.port} (${recovered} interrupted turn(s) recovered)`)
})

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[headless-runner] ${signal}: interrupting in-flight turns`)
  server.close()
  await runner.shutdown()
  store.close()
  process.exit(0)
}
process.on("SIGTERM", () => void stop("SIGTERM"))
process.on("SIGINT", () => void stop("SIGINT"))
