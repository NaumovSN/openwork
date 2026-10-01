import { test } from "node:test"
import assert from "node:assert/strict"
import {
  expandTemplate,
  redactSecretText,
  secretConnectionIdentity,
  templateNames,
  validateTemplateHeaders,
} from "../src/secrets-template.js"

test("references expand once, preserve literal strings, and never execute syntax", () => {
  assert.deepEqual(templateNames("Bearer {!TOKEN} {!TOKEN} {!REGION}"), [
    "TOKEN",
    "REGION",
  ])
  assert.equal(
    expandTemplate("Bearer {!TOKEN}", new Map([["TOKEN", "{!OTHER}"]])),
    "Bearer {!OTHER}",
  )
  assert.equal(expandTemplate("literal", new Map()), "literal")
  for (const text of ["{!token}", "{!TOKEN", "{!}", "{!TOKEN.foo}"])
    assert.throws(() => templateNames(text), /Use a reference/)
  assert.throws(() => expandTemplate("{!MISSING}", new Map()), /required value/)
})
test("header injection, oversized expansion, and unsafe transport headers are refused", () => {
  for (const value of ["token\r\nX-Evil: yes", "token\x00", "x".repeat(8193)])
    assert.throws(
      () => expandTemplate("{!TOKEN}", new Map([["TOKEN", value]])),
      /cannot be sent/,
    )
  for (const name of [
    "Host",
    "Cookie",
    "Proxy-Authorization",
    "X-Forwarded-Host",
    "Mcp-Session-Id",
    "bad name",
  ])
    assert.throws(() =>
      validateTemplateHeaders([{ name, template: "{!TOKEN}" }], "none"),
    )
  assert.throws(
    () =>
      validateTemplateHeaders(
        [{ name: "Authorization", template: "Bearer {!TOKEN}" }],
        "oauth",
      ),
    /existing bearer or OAuth/,
  )
  assert.throws(
    () =>
      validateTemplateHeaders(
        [
          { name: "X-Key", template: "{!TOKEN}" },
          { name: "x-key", template: "{!TOKEN}" },
        ],
        "none",
      ),
    /unique/,
  )
  validateTemplateHeaders(
    [
      { name: "Authorization", template: "Bearer {!TOKEN}" },
      { name: "X-Workspace", template: "{!REGION}" },
    ],
    "none",
  )
})
test("raw, escaped and commonly encoded secret echoes are redacted", () => {
  const secret = 'private/"token'
  const candidates = [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
    JSON.stringify(secret).slice(1, -1),
  ]
  for (const value of candidates)
    assert.equal(
      redactSecretText(`reply=${value}`, [secret]),
      "reply=[REDACTED]",
    )
})
test("destination approval tracks URL, authentication method and ownership mode", () => {
  const base = {
    url: "https://example.test/mcp",
    authType: "none",
    credentialMode: "per_member",
  }
  for (const delta of [
    { url: "https://elsewhere.test/mcp" },
    { authType: "oauth" },
    { credentialMode: "shared" },
  ])
    assert.notEqual(
      secretConnectionIdentity(base),
      secretConnectionIdentity({ ...base, ...delta }),
    )
})
