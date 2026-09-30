import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import { sha256Hex } from "@openwork/free-auto/node"
import type { AutoConfig } from "./config.js"
import { FreeRequestError } from "./errors.js"

// OpenRouter-only routing fields. Free Auto calls OpenAI directly, which does not know them, so they are dropped.
const ROUTING_FIELDS = ["provider", "models", "route", "transforms", "usage", "plugins", "reasoning"]
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }

/**
 * Like paid Models, the request is forwarded as the client sent it. Free Auto only requires its own model and some
 * messages, swaps in the real model, and asks for usage on streams so the real cost can be charged.
 */
export function prepareFreeRequest(value: unknown, config: AutoConfig) {
  if (!record(value) || value.model !== INFERENCE_FREE_MODEL_ID || !Array.isArray(value.messages) || value.messages.length === 0) {
    throw new FreeRequestError(400, "unsupported_free_inference_input", "Auto needs a chat completion request for the Auto model with at least one message. This input was not sent.")
  }
  const request = Object.fromEntries(Object.entries(value).filter(([key]) => !ROUTING_FIELDS.includes(key) && key !== "stream_options"))
  const stream = value.stream === true
  const outputLimit = value.max_completion_tokens ?? value.max_tokens
  delete request.max_tokens
  const body = JSON.stringify({ reasoning_effort: "none", ...request, model: config.upstreamModel, stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(outputLimit != null ? { max_completion_tokens: outputLimit } : {}),
    store: false })
  const choices = typeof value.n === "number" && Number.isSafeInteger(value.n) && value.n > 0 ? value.n : 1
  return { body, stream, choices }
}

export async function readFreeRequest(request: Request, maxBytes: number, signal: AbortSignal) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) {
    throw new FreeRequestError(400, "invalid_request", "Auto requires uncompressed JSON.")
  }
  if (!request.body) throw new FreeRequestError(400, "invalid_request", "A JSON body is required.")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new FreeRequestError(413, "free_inference_request_too_large", "The Auto request is too large. Nothing was sent.")
      chunks.push(chunk.value)
    }
    const bytes = Buffer.concat(chunks)
    let value: unknown
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
    catch { throw new FreeRequestError(400, "invalid_json", "The Auto request must contain valid UTF-8 JSON.") }
    return { value, bodyHash: sha256Hex(Uint8Array.from(bytes)) }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock() }
}
