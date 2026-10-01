import { createHash } from "node:crypto"

export class SecretSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(message)
  }
}

export function templateNames(template: string): string[] {
  const names = [...template.matchAll(/\{!([A-Z][A-Z0-9_]{0,63})\}/g)].map(
    (match) => match[1],
  )
  if (template.replace(/\{!([A-Z][A-Z0-9_]{0,63})\}/g, "").includes("{!")) {
    throw new SecretSetupError(
      "invalid_template",
      "Use a reference such as {!WORK_TOKEN}.",
      400,
    )
  }
  return [...new Set(names)]
}

const RESERVED_HEADERS = new Set([
  "host",
  "cookie",
  "set-cookie",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "upgrade",
  "accept",
  "origin",
  "referer",
  "user-agent",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "traceparent",
  "tracestate",
])
export function validateTemplateHeaders(
  headers: Array<{ name: string; template: string }>,
  authType: string,
) {
  const seen = new Set<string>()
  for (const header of headers) {
    const name = header.name.toLowerCase()
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      RESERVED_HEADERS.has(name) ||
      name.startsWith("proxy-") ||
      name.startsWith("x-forwarded-") ||
      name === "forwarded" ||
      name.startsWith("sec-")
    ) {
      throw new SecretSetupError(
        "invalid_header",
        "Use an authentication or application header, not a transport header.",
        400,
      )
    }
    if (seen.has(name))
      throw new SecretSetupError(
        "duplicate_header",
        "Header names must be unique.",
        400,
      )
    if (name === "authorization" && authType !== "none")
      throw new SecretSetupError(
        "authorization_conflict",
        "Choose template authentication instead of an existing bearer or OAuth method.",
        400,
      )
    seen.add(name)
    if (!templateNames(header.template).length)
      throw new SecretSetupError(
        "reference_required",
        "Each template header must reference a secret or variable.",
        400,
      )
  }
}

export function expandTemplate(
  template: string,
  values: ReadonlyMap<string, string>,
): string {
  const result = template.replace(
    /\{!([A-Z][A-Z0-9_]{0,63})\}/g,
    (_match, name: string) => {
      const value = values.get(name)
      if (value === undefined)
        throw new SecretSetupError(
          "missing_value",
          "Add the required value before using this connection.",
        )
      return value
    },
  )
  if (
    /[\x00-\x1f\x7f]/.test(result) ||
    Buffer.byteLength(result, "utf8") > 8192
  )
    throw new SecretSetupError(
      "invalid_value",
      "This value cannot be sent in an HTTP header. Replace it.",
    )
  return result
}

export function secretConnectionIdentity(connection: {
  url: string
  authType: string
  credentialMode: string
  oauthConfiguration?: { authorizationServerIssuer: string | null } | null
}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        connection.url,
        connection.authType,
        connection.credentialMode,
        connection.oauthConfiguration?.authorizationServerIssuer ?? null,
      ]),
    )
    .digest("hex")
}

export function redactSecretText(
  text: string,
  secrets: Iterable<string>,
): string {
  let result = text
  const candidates = new Set<string>()
  for (const value of secrets)
    if (value) {
      candidates.add(value)
      candidates.add(encodeURIComponent(value))
      candidates.add(Buffer.from(value).toString("base64"))
      candidates.add(JSON.stringify(value).slice(1, -1))
    }
  for (const value of [...candidates].sort((a, b) => b.length - a.length))
    result = result.split(value).join("[REDACTED]")
  return result
}
