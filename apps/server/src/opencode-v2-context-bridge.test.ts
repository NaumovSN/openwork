import { expect, test } from "bun:test";
import { z } from "zod";
import { createV2ContextBridge } from "./opencode-v2-context-bridge.js";

test("native read capability is authenticated, isolated, and never offers commands", async () => {
  const requests: string[] = [];
  const bridge = await createV2ContextBridge(async (path, init) => {
    requests.push(path);
    if (path === "/experimental/connect/skills") return { skills: [] };
    if (path === "/experimental/ui-control/request") {
      const body: unknown = JSON.parse(String(init?.body));
      if (body && typeof body === "object" && "kind" in body && body.kind === "context") return {
        ok: true, context: { screen: "session", availableAffordances: [
          { id: "screen.read", kind: "query" }, { id: "screen.change", kind: "command" },
        ] },
      };
      return { ok: false, error: "Unknown read" };
    }
    throw new Error("Unexpected host request");
  });
  try {
    expect((await fetch(bridge.url, { method: "POST", body: "{}" })).status).toBe(401);
    expect(requests).toHaveLength(0);
    const call = (name: string) => fetch(bridge.url, { method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input: {} }),
    });
    expect((await call("openwork_execute")).status).toBe(400);
    expect(requests).toHaveLength(0);
    const result = await call("openwork_context");
    expect(result.status).toBe(200);
    const context = await result.text();
    expect(context).toContain("screen.read");
    expect(context).toContain("session.search");
    expect(context).toContain("session.read");
    expect(context).not.toContain("screen.change");
    expect(context).not.toContain('"kind":"command"');
    expect(context).not.toContain(bridge.token);
  } finally { await bridge.close(); }
});

test("reads and searches sessions that exist only on v1 while chat runs on v2", async () => {
  const requests: Array<{ path: string; method: string }> = [];
  const home = "/tmp/bridge-workspace";
  const v1 = (id: string, title: string, created: number) => ({ id, title, directory: home, time: { created, updated: created } });
  const v2 = (id: string, title: string, created: number) => ({ id, title, location: { directory: home }, time: { created, updated: created } });
  const bridge = await createV2ContextBridge(async (path, init) => {
    requests.push({ path, method: init?.method ?? "GET" });
    const url = new URL(path, "http://host");
    if (url.pathname === "/workspaces") return { items: [{ id: "ws", name: "Main", path: home }] };
    // v2 holds a native chat and the imported copy of a pre-migration v1 chat (same id).
    if (url.pathname === "/workspace/ws/opencode2/api/session") return { data: [v2("ses_v2", "Kestrel review", 300), v2("ses_old", "Old plan", 100)], cursor: { next: null } };
    if (url.pathname === "/workspace/ws/opencode2/api/session/active") return { data: {} };
    if (url.pathname === "/workspace/ws/opencode2/api/session/ses_v2") return { data: v2("ses_v2", "Kestrel review", 300) };
    if (/^\/workspace\/ws\/opencode2\/api\/session\/ses_v2\/(permission|form)$/.test(url.pathname)) return { data: [] };
    if (url.pathname === "/workspace/ws/opencode2/api/model" || url.pathname === "/workspace/ws/opencode2/api/provider") return { data: [] };
    if (url.pathname === "/workspace/ws/opencode2/api/session/ses_v2/message") return { data: [{ id: "m2", type: "user", time: { created: 301 }, text: "kestrel notes" }], cursor: { next: null } };
    if (url.pathname === "/workspace/ws/opencode2/api/session/ses_old/message") return { data: [{ id: "m0", type: "user", time: { created: 101 }, text: "kestrel archive" }], cursor: { next: null } };
    if (url.pathname.startsWith("/workspace/ws/opencode2/api/")) throw new Error("OpenWork read failed (404)");
    // v1 still holds the pre-migration chat and one created after the import.
    if (url.pathname === "/workspace/ws/opencode/session") return [v1("ses_old", "Old plan", 100), v1("ses_v1", "Kestrel headless run", 400)];
    if (url.pathname === "/workspace/ws/opencode/session/ses_v1") return v1("ses_v1", "Kestrel headless run", 400);
    if (url.pathname === "/workspace/ws/opencode/session/ses_v1/message") return [{ info: { id: "m1", role: "user", time: { created: 401 } }, parts: [{ type: "text", text: "kestrel headless" }] }];
    if (url.pathname === "/workspace/ws/opencode/session/status") return {};
    if (url.pathname === "/workspace/ws/opencode/permission" || url.pathname === "/workspace/ws/opencode/question") return [];
    if (url.pathname.endsWith("/children")) return [];
    if (url.pathname === "/workspace/ws/opencode/provider") return { all: [], connected: [] };
    throw new Error(`Unexpected host request ${path}`);
  });
  const query = async (id: string, args: Record<string, unknown>) => {
    const response = await fetch(bridge.url, { method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_query", input: { id, args } }),
    });
    expect(response.status).toBe(200);
    const result: unknown = JSON.parse(await response.text());
    return result;
  };
  try {
    expect(await query("session.read", { sessionId: "ses_v1" })).toMatchObject({ ok: true, result: {
      sessionId: "ses_v1", engine: "v1", title: "Kestrel headless run", messages: [{ role: "user", text: "kestrel headless" }],
    } });
    expect(await query("session.read", { sessionId: "ses_v2" })).toMatchObject({ ok: true, result: { sessionId: "ses_v2", engine: "v2" } });

    const searched = await query("session.search", { query: "kestrel" });
    expect(searched).toMatchObject({ ok: true, result: { workspaceErrors: [], totalCandidateSessions: 3 } });
    const found = z.object({ result: z.object({ results: z.array(z.object({ sessionId: z.string(), engine: z.string() })) }) })
      .parse(searched).result.results.map(result => `${result.sessionId}:${result.engine}`);
    // The imported chat is listed once, from the chat engine.
    expect(found.sort()).toEqual(["ses_old:v2", "ses_v1:v1", "ses_v2:v2"]);
    expect(requests.every(request => request.method === "GET" || request.path === "/experimental/ui-control/request")).toBe(true);
  } finally { await bridge.close(); }
});
