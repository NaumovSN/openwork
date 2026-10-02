import type { ModelCatalog } from "./app.js"
import type { Config } from "./config.js"
import { FILE_TOOL_NAMES } from "./files.js"
import { remoteMcpConnector } from "./mcp.js"
import { anthropicModel, fetchGatewayModels, openAIModel, type ModelOption } from "./model.js"
import { Runner } from "./runner.js"
import type { Store } from "./store.js"

/** The runner for one store, wired to the configured Gateway route and OpenWork MCP. Shared by the Node server and the Worker. */
export function createRunner(config: Config, store: Store) {
  return new Runner({
    store,
    model:
      config.model.protocol === "anthropic"
        ? anthropicModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens })
        : openAIModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens }),
    defaultModel: config.model.model,
    defaultModelApiKey: config.model.defaultApiKey,
    mcp: config.mcp
      ? remoteMcpConnector({ url: config.mcp.url, allowlist: config.mcp.toolAllowlist, reservedNames: FILE_TOOL_NAMES })
      : undefined,
    limits: config.limits,
    systemPrompt: config.systemPrompt,
  })
}

/** The Gateway's model list, cached for five minutes; on failure only the default model is offered. */
export function gatewayModelCatalog(config: Config): () => Promise<ModelCatalog> {
  let cached: { at: number; models: ModelOption[] } | null = null
  return async () => {
    const fallback = [{ id: config.model.model, name: config.model.model }]
    const apiKey = config.model.defaultApiKey
    if (!apiKey) return { defaultModel: config.model.model, models: fallback }
    if (!cached || Date.now() - cached.at > 5 * 60_000) {
      try {
        cached = {
          at: Date.now(),
          models: await fetchGatewayModels({ baseUrl: config.model.baseUrl, protocol: config.model.protocol, apiKey }),
        }
      } catch {
        return { defaultModel: config.model.model, models: fallback }
      }
    }
    return { defaultModel: config.model.model, models: cached.models.length ? cached.models : fallback }
  }
}
