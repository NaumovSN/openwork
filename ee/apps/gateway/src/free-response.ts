import { INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import type { FreeUsageReceipt } from "./free-allowance.js"

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
export function readFreeUsage(value: unknown, eventId: string): FreeUsageReceipt | null {
  if (!record(value) || !record(value.usage) || value.model !== INFERENCE_FREE_MODEL_ID) return null
  const usage = value.usage
  if (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0 || usage.is_byok !== true
    || !record(usage.cost_details) || typeof usage.cost_details.upstream_inference_cost !== "number"
    || !Number.isFinite(usage.cost_details.upstream_inference_cost) || usage.cost_details.upstream_inference_cost < 0
    || !nonnegative(usage.prompt_tokens) || !nonnegative(usage.completion_tokens)) return null
  const amount = Math.ceil((usage.cost + usage.cost_details.upstream_inference_cost) * INFERENCE_USAGE_CONVERSION_FACTOR)
  if (!nonnegative(amount)) return null
  if (record(usage.completion_tokens_details) && usage.completion_tokens_details.reasoning_tokens !== undefined
    && (!nonnegative(usage.completion_tokens_details.reasoning_tokens) || usage.completion_tokens_details.reasoning_tokens > usage.completion_tokens)) return null
  return { amount, eventId, model: INFERENCE_FREE_MODEL_ID, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
}
function publicResponse(value: Record<string, unknown>) {
  if (!record(value.usage)) return value
  const usage: Record<string, number> = {}
  for (const name of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (nonnegative(value.usage[name])) usage[name] = value.usage[name]
  }
  return { ...value, usage }
}

export class FreeResponseReceipt {
  private id: string | null = null
  private terminal = false
  private receipt: FreeUsageReceipt | null = null
  private sawModel = false
  private invalidUsage = false
  done = false
  accept(value: unknown): Record<string, unknown> {
    if (this.done || !record(value) || value.error != null || !Array.isArray(value.choices) || value.choices.length > 1) throw new Error("Incomplete Auto response")
    if (value.id !== undefined) {
      if (typeof value.id !== "string" || !value.id || value.id.length > 255 || this.id !== null && this.id !== value.id) throw new Error("Mismatched Auto response identity")
      this.id = value.id
    }
    if (value.model !== undefined) {
      if (value.model !== INFERENCE_FREE_MODEL_ID) throw new Error("Mismatched Auto model")
      this.sawModel = true
    }
    for (const choice of value.choices) {
      if (!record(choice) || choice.index !== 0) throw new Error("Invalid Auto choice")
      if (this.terminal && record(choice.delta) && Object.values(choice.delta).some((part) => part !== null && part !== "")) throw new Error("Output after Auto completion")
      if (choice.finish_reason != null) {
        if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(String(choice.finish_reason))) throw new Error("Invalid Auto completion")
        this.terminal = true
      }
    }
    if (this.terminal && this.id && this.sawModel && record(value.usage)) {
      const receipt = readFreeUsage({ ...value, model: INFERENCE_FREE_MODEL_ID }, this.id)
      if (receipt && this.receipt && JSON.stringify(receipt) !== JSON.stringify(this.receipt)) throw new Error("Conflicting Auto usage")
      if (receipt) this.receipt = receipt
      else this.invalidUsage = true
    }
    return publicResponse(value)
  }
  complete() {
    if (!this.terminal || !this.id || !this.sawModel || this.done) throw new Error("Incomplete Auto response")
    this.done = true
    return this.invalidUsage ? null : this.receipt
  }
}

export function meterFreeResponse(body: ReadableStream<Uint8Array>, input: {
  streaming: boolean; maxBytes: number; signal: AbortSignal;
  settle: (receipt: FreeUsageReceipt | null) => Promise<void>;
}) {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  const receipt = new FreeResponseReceipt()
  let pending = "", data: string[] = [], bytes = 0, closed = false
  let settlement: Promise<void> | null = null
  const settle = (value: FreeUsageReceipt | null) => settlement ??= input.settle(value).catch(() => undefined)
  const cleanup = () => { input.signal.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined) }
  let output: ReadableStreamDefaultController<Uint8Array>
  const fail = (error: unknown) => {
    if (closed) return
    closed = true
    cleanup()
    void settle(null)
    output.error(error)
  }
  const abort = () => fail(new Error("Auto response cancelled"))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller
      input.signal.addEventListener("abort", abort, { once: true })
      if (input.signal.aborted) abort()
    },
    async pull(controller) {
      try {
        while (!closed) {
          const chunk = await reader.read()
          if (closed) return
          if (chunk.done) {
            pending += decoder.decode()
            if (input.streaming) throw new Error("Auto stream ended before completion")
            const value = receipt.accept(JSON.parse(pending))
            await settle(receipt.complete())
            if (closed) return
            controller.enqueue(encoder.encode(JSON.stringify(value)))
            closed = true
            cleanup()
            controller.close()
            return
          }
          bytes += chunk.value.byteLength
          if (bytes > input.maxBytes) throw new Error("Auto response too large")
          pending += decoder.decode(chunk.value, { stream: true })
          if (pending.length > input.maxBytes) throw new Error("Auto response frame too large")
          if (!input.streaming) continue
          let newline: number
          let emitted = false
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, "")
            pending = pending.slice(newline + 1)
            if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
            else if (line.startsWith("event:") && line.slice(6).trim() === "error") throw new Error("Auto upstream failed")
            else if (!line && data.length) {
              const text = data.join("\n")
              data = []
              if (text.trim() === "[DONE]") {
                await settle(receipt.complete())
                if (closed) return
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                closed = true
                cleanup()
                controller.close()
                return
              }
              const value = receipt.accept(JSON.parse(text))
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
              emitted = true
            }
          }
          if (emitted) return
        }
      } catch (error) { fail(error) }
    },
    async cancel() { if (!closed) { closed = true; cleanup(); await settle(null) } },
  }, { highWaterMark: 0 })
}
