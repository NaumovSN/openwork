import type { MiddlewareHandler } from "hono"

const encoder = new TextEncoder()

/** Constant-time compare; only the length of the (random, 32+ char) token can leak. */
export function tokensMatch(candidate: string, expected: string) {
  const actual = encoder.encode(candidate)
  const wanted = encoder.encode(expected)
  if (actual.length !== wanted.length) return false
  let difference = 0
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ wanted[index]
  return difference === 0
}

/** Requires `Authorization: Bearer <service token>`. The token is read per request, so a Worker can take it from its env. */
export function bearerAuth(apiToken: (context: Parameters<MiddlewareHandler>[0]) => string): MiddlewareHandler {
  return async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")
    if (!match || !tokensMatch(match[1], apiToken(c))) return c.json({ error: "unauthorized" }, 401)
    await next()
  }
}
