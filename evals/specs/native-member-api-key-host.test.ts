import { test } from "@openwork/testkit";
import { expect } from "vitest";
import { randomBytes } from "node:crypto";
import { createMemberApiKeyService, memberApiKeyProofEnabled } from "../../apps/desktop/electron/member-api-key.mjs";

test("native credential host pins actor and revision, consumes handles and sanitizes outcomes", async ({ evidence }) => {
  const key = randomBytes(24).toString("hex");
  let organizationId = "org_a";
  let revision = "2026-09-30T00:00:00.000Z";
  let posts = 0;
  let observedPlacement = false;
  let responseMode = "saved";
  const receipts: unknown[] = [];
  let observerThrows = false;
  const service = createMemberApiKeyService({
    observeSaved: (receipt: unknown) => { receipts.push(receipt); if (observerThrows) throw new Error(key); },
    readState: async () => ({ apiBaseUrl: "https://api.example.test", token: "synthetic-session", organizationId }),
    fetch: async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(init.redirect).toBe("error");
      if (url.endsWith("/v1/me")) return Response.json({ user: { id: "user_a" }, session: { id: "session_a" } });
      if (url.endsWith("/v1/me/orgs")) return Response.json({ orgs: [{ id: organizationId, membershipId: "member_a" }] });
      if (url.includes("?scope=usable")) return Response.json({ connections: [{ id: "mcp_one", name: "Private tools", authType: "apikey", credentialMode: "per_member", updatedAt: revision }] });
      posts++;
      observedPlacement = typeof init.body === "string" && JSON.parse(init.body).apiKey === key
        && !url.includes(key) && !JSON.stringify([...headers]).includes(key)
        && headers.get("If-Match") === null
        && headers.get("x-openwork-org-id") === "org_a";
      if (responseMode === "throw") throw new Error(key);
      if (responseMode === "invalid") return Response.json({ error: "invalid_request", message: key }, { status: 400 });
      if (responseMode === "proxy-timeout") return new Response("Gateway timeout", { status: 504 });
      if (responseMode === "unknown-success") return Response.json({ message: "unknown" });
      return Response.json({ ok: true, ignoredSecret: key });
    },
  });
  const prepare = async () => {
    const result = await service.prepare(1, "mcp_one");
    expect(result.ok).toBe(true);
    if (!("context" in result)) throw new Error("Preparation did not produce a context");
    return result.context;
  };
  try {
    const prepared = await prepare();
    const result = await service.submit(1, prepared.handle, key);
    expect(result).toEqual({ ok: true, saved: true });
    expect(observedPlacement).toBe(true);
    expect(JSON.stringify(result).includes(key)).toBe(false);
    expect(receipts).toEqual([{ httpStatus: 200, stored: true, organizationId: "org_a", memberId: "member_a", connectionId: "mcp_one" }]);
    expect(await service.submit(1, prepared.handle, key)).toEqual({ ok: false, code: "busy" });
    expect(posts).toBe(1);
    const stale = await prepare();
    organizationId = "org_b";
    expect(await service.submit(1, stale.handle, key)).toEqual({ ok: false, code: "context_changed" });
    expect(posts).toBe(1);
    organizationId = "org_a";
    const changed = await prepare();
    revision = "2026-09-30T00:00:01.000Z";
    expect(await service.submit(1, changed.handle, key)).toEqual({ ok: false, code: "context_changed" });
    expect(posts).toBe(1);
    for (const mode of ["invalid", "throw", "proxy-timeout", "unknown-success"]) {
      responseMode = mode;
      const next = await prepare();
      const failure = await service.submit(1, next.handle, key);
      expect(failure).toEqual({ ok: false, code: mode === "invalid" ? "invalid_input" : "uncertain" });
      expect(JSON.stringify(failure).includes(key)).toBe(false);
    }
    const cancelled = await prepare();
    service.cancel(1, cancelled.handle);
    expect(await service.submit(1, cancelled.handle, key)).toEqual({ ok: false, code: "expired" });
    expect(posts).toBe(5);
    expect(receipts).toHaveLength(1);
    observerThrows = true;
    responseMode = "saved";
    const throwingObserver = await prepare();
    expect(await service.submit(1, throwingObserver.handle, key)).toEqual({ ok: true, saved: true });
    expect(posts).toBe(6);
    expect(receipts).toHaveLength(2);
    expect(JSON.stringify(receipts).includes(key)).toBe(false);
    for (const packaged of [true, false]) for (const development of [true, false]) for (const optIn of [undefined, "0", "1"]) {
      expect(memberApiKeyProofEnabled({ packaged, development, optIn })).toBe(!packaged && development && optIn === "1");
    }
    evidence.recordAssertionEvidence("Test observer cannot alter storage and is never packaged-enabled", "Fixed identity/status projection only after acknowledged same-context save; uncertain/rejected paths emit none; throwing observer does not alter result or POST count; packaged/development/opt-in gate truth table", true);
    evidence.recordAssertionEvidence("Host scope and single-submit boundary", "Body-only candidate; fixed result projection; org/revision/cancel deny without POST; response loss remains uncertain", true);
  } finally { service.dispose(1); }
});
