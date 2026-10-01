import type { ExternalMcpConnectionRow } from "./capability-sources/external-mcp-connections.js"
import type { ExternalMcpMemberContext } from "./capability-sources/external-mcp-client.js"
import { env } from "./env.js"
import { getSecretBinding, resolveSecretHeaders } from "./secrets-store.js"
import {
  SecretSetupError,
  redactSecretText,
  secretConnectionIdentity,
} from "./secrets-template.js"

function redactedResponse(response: Response, secrets: Set<string>): Response {
  if (!secrets.size) return response
  const isEventStream = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  // Keep a tail so a credential split across network chunks is still removed.
  const hold =
    Math.max(
      ...[...secrets].map((value) =>
        Math.max(
          value.length,
          encodeURIComponent(value).length,
          Buffer.from(value).toString("base64").length,
          JSON.stringify(value).length,
        ),
      ),
    ) + 32
  let pending = ""
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      if (isEventStream) {
        // Complete SSE frames contain no raw header control characters; flush
        // them promptly rather than holding a sparse, long-lived MCP stream.
        const end = pending.lastIndexOf("\n\n")
        if (end >= 0) {
          controller.enqueue(
            encoder.encode(
              redactSecretText(pending.slice(0, end + 2), secrets),
            ),
          )
          pending = pending.slice(end + 2)
        }
      }
      if (pending.length > hold * 2) {
        // Redact before splitting: no part of a complete match crosses the cut.
        pending = redactSecretText(pending, secrets)
        const cut = pending.length - hold
        controller.enqueue(encoder.encode(pending.slice(0, cut)))
        pending = pending.slice(cut)
      }
    },
    flush(controller) {
      controller.enqueue(
        encoder.encode(redactSecretText(pending + decoder.decode(), secrets)),
      )
    },
  })
  const headers = new Headers(response.headers)
  for (const [name, value] of headers)
    headers.set(name, redactSecretText(value, secrets))
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(
    response.body ? response.body.pipeThrough(stream) : null,
    { status: response.status, statusText: response.statusText, headers },
  )
}

export function createSecretTemplateFetch(input: {
  connection: ExternalMcpConnectionRow
  member?: ExternalMcpMemberContext
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>
}): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (request, init) => {
    const binding = await getSecretBinding(
      input.connection.organizationId,
      input.connection.id,
    )
    if (!binding || !binding.headers.length) return input.fetch(request, init)
    const url = new URL(request)
    // MCP templates never travel to OAuth metadata, registration, or token URLs.
    if (url.href !== new URL(input.connection.url).href)
      return input.fetch(request, init)
    if (binding.identity !== secretConnectionIdentity(input.connection))
      throw new SecretSetupError(
        "connection_changed",
        "This connection changed. Review its current credential destination.",
      )
    if (!input.member)
      throw new SecretSetupError(
        "secret_setup_required",
        "Use this connection as a signed-in workspace member.",
      )
    if (
      url.protocol !== "https:" &&
      !(
        env.allowPrivateMcpUrls &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new SecretSetupError(
        "https_required",
        "Credentials require an HTTPS MCP endpoint.",
      )
    const resolved = await resolveSecretHeaders(
      {
        organizationId: input.connection.organizationId,
        memberId: input.member.orgMembershipId,
      },
      input.connection.id,
    )
    if (
      resolved.identity !== secretConnectionIdentity(input.connection) ||
      resolved.endpoint !== input.connection.url
    )
      throw new SecretSetupError(
        "connection_changed",
        "This connection changed. Review its current credential destination.",
      )
    const headers = new Headers(init?.headers)
    for (const [name, value] of resolved.headers) headers.set(name, value)
    try {
      const response = await input.fetch(request, {
        ...init,
        headers,
        redirect: "error",
      })
      return redactedResponse(response, resolved.secrets)
    } catch (error) {
      if (error instanceof SecretSetupError) throw error
      // Fetch errors may carry provider details; expose only a safe action.
      throw new SecretSetupError(
        "connection_request_failed",
        "The connection request failed. Check the endpoint and try again.",
      )
    }
  }
}
