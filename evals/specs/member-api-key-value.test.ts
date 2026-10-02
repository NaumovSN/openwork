import { expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import { validMemberApiKey, memberApiKeyAuthorization } from "../../ee/apps/den-api/src/capability-sources/member-api-key.js";
import { createGuardedFetch, createRealmSafeFetch } from "../../ee/apps/den-api/src/capability-sources/url-guard.js";
import { createExternalMcpDiagnosticFetch, ExternalMcpDiagnosticTracker, externalMcpDiagnosticForLog, externalMcpDiagnosticForResponse, providerToolDiagnosticError } from "../../ee/apps/den-api/src/capability-sources/external-mcp-diagnostics.js";

test("personal API keys are raw bounded values, never header instructions", async ({ evidence }) => {
  expect(memberApiKeyAuthorization("synthetic-member-a")).toBe("Bearer synthetic-member-a");
  expect(memberApiKeyAuthorization("synthetic-member-a", "token")).toBe("Token synthetic-member-a");
  for (const value of ["", "Bearer synthetic", "Token synthetic", "x\r\ny:z", "x\0", "x\t", "x ", "é", "x".repeat(8193)]) {
    expect(validMemberApiKey(value)).toBe(false);
    expect(() => memberApiKeyAuthorization(value)).toThrow("A valid personal API key is required.");
  }
  expect(validMemberApiKey("x".repeat(8192))).toBe(true);
  evidence.recordAssertionEvidence("Bounded token-only Bearer contract", "Synthetic input accepts raw tokens, rejects prefixes, whitespace, controls, non-ASCII and overlong values without echoing the value.", true);
});

test("typed Token transport receives the existing diagnostic credential redaction", async ({ evidence }) => {
  const key = "synthetic-short-token";
  const tracker = new ExternalMcpDiagnosticTracker("synthetic-token-redaction", { authType: "apikey", credentialMode: "per_member" });
  tracker.begin("MCP_INITIALIZE");
  const diagnosticFetch = createExternalMcpDiagnosticFetch({ endpoint: "https://provider.example.test/mcp", tracker,
    fetch: async () => new Response(JSON.stringify({ error: "invalid_token", error_description: `Rejected Token ${key}` }), { status: 401, headers: { "content-type": "application/json" } }),
  });
  await diagnosticFetch("https://provider.example.test/mcp", { method: "POST", headers: { authorization: `Token ${key}` } });
  const serialized = JSON.stringify(externalMcpDiagnosticForLog(tracker.error(new Error("Provider rejected credentials")), "synthetic-token-redaction", "MCP_INITIALIZE"));
  expect(serialized).not.toContain(key);
  expect(serialized).toContain("[redacted]");
  evidence.recordAssertionEvidence("Token-prefixed provider diagnostics are redacted", "A synthetic short Token credential in an actual diagnostic fetch response is absent from the log projection and replaced with a redaction marker; no request or real credential was logged.", true);
});

test("provider tool error projections redact both schemes across the allowed raw-key alphabet", ({ evidence }) => {
  const strings = (value: unknown): string[] => typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (const scheme of ["Bearer", "Token", "tOkEn"]) for (const key of ["q", "abc1234", "a:!\"%&'()*+,./;<=>?@[\\]^_`{|}~", "synthetic-bearer-control"]) {
      const cases = [
        { text: `403 forbidden ${scheme} ${key}`, expected: `403 forbidden ${scheme} [redacted]` },
        { text: `403 forbidden Authorization: ${scheme} ${key}`, expected: "403 forbidden Authorization: [redacted] [redacted]" },
        { text: `403 forbidden ${JSON.stringify({ authorization: `${scheme} ${key}` })}`, expected: `403 forbidden {"authorization":"${scheme} [redacted]` },
      ];
      for (const entry of cases) {
        log.mockClear();
        const tracker = new ExternalMcpDiagnosticTracker("synthetic-provider-tool-redaction", { authType: "apikey", credentialMode: "per_member" });
        const error = providerToolDiagnosticError({ tracker, result: { isError: true, content: [{ type: "text", text: entry.text }] } });
        const projections = strings([externalMcpDiagnosticForResponse(error, "synthetic-provider-tool-redaction", "MCP_TOOL_EXECUTION"),
          externalMcpDiagnosticForLog(error, "synthetic-provider-tool-redaction", "MCP_TOOL_EXECUTION"), log.mock.calls]);
        expect(projections.some((value) => value.includes(`${scheme} ${key}`))).toBe(false);
        expect(projections.includes(entry.expected)).toBe(true);
      }
    }
    evidence.recordAssertionEvidence("Provider tool errors reuse scheme credential redaction", "Actual exported response/log/console paths match exact redacted excerpts for bare, canonical unquoted and quoted Authorization forms across Bearer/Token/mixed-case, short values and printable punctuation. Prefix redaction runs before pair rules can strip a scheme. No raw fixture output; arbitrary prefixless echo is not claimed.", true);
  } finally { log.mockRestore(); }
});

test("credential-bound redirect refusal preserves ordinary shared and OAuth fetch policy", async ({ evidence }) => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const location of ["https://provider.example.test/next", "https://other.example.test/next"]) {
      let requests = 0;
      const guarded = createRealmSafeFetch(async () => { requests += 1; return new Response(null, { status, headers: { location } }); });
      await expect(guarded("https://provider.example.test/start", { redirect: "error", headers: { authorization: "Bearer synthetic", cookie: "synthetic-cookie=fixture" } })).rejects.toThrow("refused a redirect");
      expect(requests).toBe(1);
    }
  }
  const ordinary: { url: string; authorization: string | null }[] = [];
  const shared = createRealmSafeFetch(async (url, init) => {
    ordinary.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return ordinary.length === 1 ? new Response(null, { status: 302, headers: { location: "/next" } }) : new Response("ok");
  });
  expect((await shared("https://provider.example.test/start", { headers: { authorization: "Bearer synthetic-shared" } })).status).toBe(200);
  expect(ordinary).toEqual([{ url: "https://provider.example.test/start", authorization: "Bearer synthetic-shared" }, { url: "https://provider.example.test/next", authorization: "Bearer synthetic-shared" }]);
  let loopRequests = 0;
  const loop = createRealmSafeFetch(async () => { loopRequests += 1; return new Response(null, { status: 302, headers: { location: "/loop" } }); });
  await expect(loop("https://provider.example.test/loop")).rejects.toThrow("redirect limit");
  expect(loopRequests).toBeLessThanOrEqual(11);
  let privateRequests = 0;
  const hosted = createGuardedFetch(async () => { privateRequests += 1; return new Response("must not run"); });
  await expect(hosted("https://127.0.0.1/private", { redirect: "error" })).rejects.toThrow("not allowed");
  expect(privateRequests).toBe(0);
  evidence.recordAssertionEvidence("Redirect policy composition", "Explicit error policy rejected all five statuses at the first source request with synthetic Authorization/Cookie, unchanged ordinary same-origin policy followed with its shared credential, redirect loops remained bounded, hosted guard rejected literal loopback before fetch.", true);
});
