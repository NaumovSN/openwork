import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { app, browserScript, control, eventually, evalIn, mcpMock, needs, screenshot, server, test } from "@openwork/testkit";
import { denFetch, engineSessionProbe, sendComposerMessage, waitFor } from "@openwork/testkit";
import { connectionResponse, inventoryResponse, tokenResponse, organizationResponse, requireOwnedDen } from "./member-api-key-fixture";
import type { App } from "@openwork/testkit";
import { createNativeMemberKeySurface } from "./native-member-api-key-surface";

async function configureModel(surface: App, modelUrl: string, gatewayUrl: string, gatewayToken: string) {
  await evalIn(surface, browserScript(async (workspaceId, modelUrl, gatewayUrl, gatewayToken) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) throw Error("No owned server");
    const headers = { Authorization: `Bearer ${info.ownerToken}`, "Content-Type": "application/json" };
    const root = info.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${root}/workspace/${workspaceId}/config`, { method: "PATCH", headers,
      body: JSON.stringify({ opencode: { model: "native-proof/proof", small_model: "native-proof/proof", provider: {
        "native-proof": { npm: "@ai-sdk/openai-compatible", name: "Native proof", options: { baseURL: `${modelUrl}/v1`, apiKey: "fixture-model-only" },
          models: { proof: { name: "Native credential proof model", tool_call: true } } },
      } } }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Error("Model fixture configuration failed");
    const connection = await fetch(`${root}/workspace/${workspaceId}/mcp/openwork-cloud/reconcile`, { method: "POST", headers,
      body: JSON.stringify({ config: { type: "remote", url: gatewayUrl, enabled: true, oauth: false, headers: { Authorization: `Bearer ${gatewayToken}` } }, trigger: "native-credential-fixture" }),
      signal: AbortSignal.timeout(45_000) });
    if (!connection.ok) throw Error("Owned member gateway configuration failed");
    const reload = await fetch(`${root}/workspace/${workspaceId}/engine/reload`, { method: "POST", headers, signal: AbortSignal.timeout(60_000) });
    if (!reload.ok) {
      const value: unknown = await reload.json().catch(() => null);
      const outer = value && typeof value === "object" ? value : {};
      const nested = "error" in outer && outer.error && typeof outer.error === "object" ? outer.error : outer;
      const code = "code" in nested && typeof nested.code === "string" ? nested.code : "unknown";
      const safeCode = ["opencode_unconfigured", "opencode_reload_timeout", "opencode_engine_unreachable", "opencode_reload_failed"].includes(code) ? code : "unknown";
      throw Error(`Owned engine reload failed; HTTP ${reload.status}; code ${safeCode}`);
    }
    localStorage.setItem("openwork.defaultModel", "native-proof/proof");
  }, [surface.workspaceId, modelUrl, gatewayUrl, gatewayToken]), { awaitPromise: true, timeoutMs: 90_000 });
  await evalIn(surface, () => location.reload());
  await waitFor(surface, () => Boolean(window.__openworkControl), { timeoutMs: 60_000, label: "owned desktop reload" });
}

async function clickText(surface: App, text: string) {
  try { await eventually(() => evalIn(surface, browserScript((label) => {
    const exact = [...document.querySelectorAll("button,[role=button]")].find((entry) => entry.textContent?.trim() === label);
    const textNode = [...document.querySelectorAll("span,p,h2,h3")].find((entry) => entry.textContent?.trim() === label);
    const element = exact ?? textNode?.closest("button,[role=button]");
    if (!(element instanceof HTMLElement)) return false;
    element.click(); return true;
  }, [text])), { within: 30_000, label: `native action ${text}`, until: Boolean }); }
  catch (error) { await screenshot(surface, { caption: `Failed native action: ${text}` }); throw error; }
}

async function submitSecret(surface: App, secret: string) {
  await eventually(() => evalIn(surface, () => {
    const input = document.querySelector('[data-testid="member-api-key-input"]');
    if (!(input instanceof HTMLInputElement) || input.disabled) return false;
    input.focus(); return input.type === "password" && input.value === "";
  }), { within: 20_000, label: "empty secure native password input", until: Boolean });
  // In-process synthetic value only. Never return a field value or a raw CDP error.
  try { await surface.client.send("Input.insertText", { text: secret }, { timeoutMs: 5_000 }); }
  catch { throw Error("Synthetic input delivery failed"); }
  await clickText(surface, "Save key");
}

test("native Electron Library enrolls two ordinary members on one real Den connection", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  requireOwnedDen();
  const analyticsBodies: string[] = [];
  const analytics = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    analyticsBodies.push(Buffer.concat(chunks).toString());
    response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"status":1}');
  });
  await new Promise<void>((resolve, reject) => { analytics.once("error", reject); analytics.listen(0, "127.0.0.1", resolve); });
  const analyticsAddress = analytics.address();
  if (!analyticsAddress || typeof analyticsAddress === "string") throw new Error("Owned analytics endpoint unavailable");
  await using ownedAnalytics = { [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => { analytics.closeAllConnections(); analytics.close((error) => error ? reject(error) : resolve()); }) };
  void ownedAnalytics;
  await using den = await server({ place, org: { name: "Native credential fixture", members: { alice: {}, blair: {}, ungranted: {} } },
    mocks: { source: mcpMock({ allowUnauthenticatedMcp: true, isolatedProcessEnv: true,
      agentWorkloads: [
        { promptMarker: "Connect my native private tools", finalReply: "Open secure Connect for your own account.", steps: [
          { tool: "search_capabilities", arguments: { query: "Native private tools", type: "mcp", intent: "connect", limit: 1 } },
        ] },
        { promptMarker: "Read my fixture identity", finalReply: "Identity read finished.", steps: [
          { tool: "search_capabilities", arguments: { query: "identity_probe", type: "mcp", limit: 1 } },
          { tool: "execute_capability", arguments: { body: {} }, argumentsFrom: "capability-search" },
        ] },
      ],
      tools: [{ name: "identity_probe", description: "Read-only fixture identity", inputSchema: { type: "object" }, result: { content: [{ type: "text", text: "fixture identity" }] } }] }) } });
  const keys = { alice: randomBytes(24).toString("hex"), blair: randomBytes(24).toString("hex") };
  const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);
  const accepted = new Set(Object.values(keys));
  const wire: { method: string; identity: string; status: number }[] = [];
  const witness = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const method = body ? JSON.parse(body).method : request.method;
    const key = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!accepted.has(key)) { wire.push({ method, identity: fingerprint(key), status: 401 }); response.writeHead(401); response.end(); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    try {
      const upstream = await fetch(den.mocks.source.mcpUrl, { method: request.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000) });
      wire.push({ method, identity: fingerprint(key), status: upstream.status });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(502); response.end(); }
  });
  await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve));
  await using ownedWitness = { [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => { witness.closeAllConnections(); witness.close((error) => error ? reject(error) : resolve()); }) };
  void ownedWitness;
  const address = witness.address();
  if (!address || typeof address === "string") throw Error("Owned witness missing");
  const api = (member: typeof den.admin, path: string, body?: unknown) => denFetch(member, path, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${member.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000),
  });
  const organization = await api(den.admin, "/v1/org");
  const memberIds = [den.members.alice.email, den.members.blair.email].map(email => {
    const member = organizationResponse.parse(organization.body).members.find(row => row.user.email === email);
    if (!member) throw new Error("Owned member absent from organization");
    return member.id;
  });
  const created = await api(den.admin, "/v1/mcp-connections", { name: "Native private tools", url: `http://127.0.0.1:${address.port}/mcp`, authType: "apikey", credentialMode: "per_member", access: { orgWide: false, memberIds } });
  expect(created.response.status).toBe(200);
  const connectionId = connectionResponse.parse(created.body).id;

  for (const memberName of ["alice", "blair"] as const) {
    await using desktop = await app({ den, as: memberName, place,
      env: { OPENWORK_EVAL_MEMBER_KEY_LOOPBACK: "1", OPENWORK_EVAL_MEMBER_KEY_OBSERVER: "1", OPENWORK_APP_NAME: "OpenWork Native Credential Proof",
        VITE_OPENWORK_POSTHOG_HOST: `http://127.0.0.1:${analyticsAddress.port}`, VITE_OPENWORK_POSTHOG_KEY: "synthetic-analytics-only" } });
    const bootstrapCheck = await evalIn(desktop, browserScript(async (apiUrl) => {
      const bootstrap = await window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig");
      return { apiConfigured: bootstrap?.apiBaseUrl === apiUrl,
        configuredApi: bootstrap?.apiBaseUrl ?? null, expectedApi: apiUrl,
        sessionOriginPresent: Boolean(localStorage.getItem("openwork.den.sessionOrigin")),
        nativeBridgePresent: "__OPENWORK_MEMBER_API_KEY__" in window };
    }, [den.ref.apiUrl]), { awaitPromise: true });
    expect(bootstrapCheck, JSON.stringify(bootstrapCheck)).toMatchObject({ apiConfigured: true, sessionOriginPresent: true, nativeBridgePresent: true });
    const minted = await api(den.members[memberName], "/v1/mcp/token", { scopes: ["mcp:read", "mcp:write"] });
    expect(minted.response.status).toBe(200);
    await configureModel(desktop, den.mocks.source.url, `${den.ref.apiUrl}/mcp/agent`, tokenResponse.parse(minted.body).token);
    await evalIn(desktop, () => {
      const entries: string[] = [];
      Reflect.set(window, "__nativeProofConsole", entries);
      for (const name of ["log", "warn", "error"] as const) {
        const original = console[name].bind(console);
        console[name] = (...args: unknown[]) => { entries.push(args.map(String).join(" ")); original(...args); };
      }
      window.addEventListener("error", event => entries.push(event.message));
      window.addEventListener("unhandledrejection", event => entries.push(String(event.reason)));
    });
    await waitFor(desktop, () => document.body.textContent?.includes("Native credential proof model") === true,
      { timeoutMs: 30_000, label: "owned witness model selected" });
    const actor = organizationResponse.parse(organization.body).members.find(row => row.user.email === den.members[memberName].email);
    if (!actor) throw new Error("Owned member absent from organization");
    const nativeSurface = createNativeMemberKeySurface({ surface: desktop, entry: memberName === "alice" ? "library" : "chat",
      connectionName: "Native private tools", memberId: actor.id, organizationId: organizationResponse.parse(organization.body).organization.id, connectionId });
    if (memberName === "alice") {
      await control(desktop, "settings.panel.open", { panel: "connect" });
      await clickText(desktop, "Sign in");
      await nativeSurface.openDialog();
    } else {
      await sendComposerMessage(desktop, "Connect my native private tools");
      await eventually(() => evalIn(desktop, () => Boolean(document.querySelector('[data-testid="desktop-connection-card"]'))),
        { within: 60_000, label: "actual discovery produces native connection card", until: Boolean });
      await screenshot(desktop, { caption: "Blair: actual discovery connection card requests own credential" });
      await nativeSurface.openDialog();
    }
    await eventually(() => evalIn(desktop, () => Boolean(document.querySelector('[data-testid="member-api-key-input"]'))),
      { within: 20_000, label: "real IPC resolves member before input", until: Boolean });
    expect(await nativeSurface.readInputState()).toEqual({ type: "password", empty: true });
    await nativeSurface.captureSafe("empty-dialog");
    const acknowledgement = await nativeSurface.armSave();
    try {
      await submitSecret(desktop, keys[memberName]);
      expect(await acknowledgement.result(45_000)).toEqual({ status: 200, body: { ok: true } });
    } finally { await acknowledgement.dispose(); }
    await eventually(() => evalIn(desktop, () => document.body.textContent?.includes("Key saved") === true),
      { within: 50_000, label: "real Den stored-only result in native modal", until: Boolean });
    expect(await nativeSurface.secretAbsentFromVisibleUi(keys[memberName])).toBe(true);
    await nativeSurface.captureSafe("key-saved");
    const inventory = await api(den.members[memberName], "/v1/mcp-connections?scope=usable");
    const row = inventoryResponse.parse(inventory.body).connections.find((entry: { id: string }) => entry.id === connectionId);
    expect(row).toMatchObject({ connectedForMe: true, credentialHealth: "unknown" });
    const privacy = await evalIn(desktop, browserScript((candidate) => ({
      dom: document.body.textContent?.includes(candidate) === true,
      url: location.href.includes(candidate),
      storage: JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes(candidate),
      console: JSON.stringify(Reflect.get(window, "__nativeProofConsole") ?? []).includes(candidate),
    }), [keys[memberName]]));
    expect(privacy).toEqual({ dom: false, url: false, storage: false, console: false });
    const logPath = desktop.handle.meta?.log;
    if (logPath) expect((await readFile(logPath, "utf8")).includes(keys[memberName])).toBe(false);
    await clickText(desktop, "Done");
    if (memberName === "alice") await clickText(desktop, "Back to app");
    // The deterministic model allows one workload per conversation. A new
    // ordinary task avoids matching the earlier Connect workload again.
    await evalIn(desktop, browserScript((workspaceId) => { location.hash = `/workspace/${workspaceId}/session`; }, [desktop.workspaceId]));
    await sendComposerMessage(desktop, "Read my fixture identity");
    try { await eventually(async () => (await den.mocks.source.toolCalls()).some((call) => call.tokenId === fingerprint(keys[memberName])),
      { within: 60_000, label: "actual native tool execution uses enrolled member key", until: Boolean }); }
    catch (error) {
      await screenshot(desktop, { caption: "Actual native tool execution did not complete" });
      const requests = await den.mocks.source.agentRequests();
      evidence.recordAssertionEvidence("Native model tool progress", JSON.stringify(requests.map((entry) => ({ kind: entry.kind, toolName: entry.toolName, completedTools: entry.completedTools, codes: entry.toolResultCodes }))), false);
      throw error;
    }
    const native = engineSessionProbe({ engine: "v1", surface: desktop, workspaceId: desktop.workspaceId });
    const sessionId = await evalIn(desktop, () => /\/session\/([^/?#]+)/.exec(location.hash || location.pathname)?.[1] ?? null);
    if (typeof sessionId !== "string") throw Error("Owned session missing");
    const transcript = await native.snapshot(sessionId);
    expect(JSON.stringify(transcript).includes(keys[memberName])).toBe(false);
    await eventually(() => evalIn(desktop, () => Boolean(document.querySelector(
      '[data-capability-call*="execute_capability"] button[data-testid="tool-details-toggle"][aria-expanded="false"]',
    ))), { within: 30_000, label: "actual capability call disclosure is rendered", until: Boolean });
    expect(await evalIn(desktop, () => {
      const button = document.querySelector('[data-capability-call*="execute_capability"] button[data-testid="tool-details-toggle"][aria-expanded="false"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      button.closest('[data-capability-call]')?.scrollIntoView({ block: "center" });
      return true;
    })).toBe(true);
    await eventually(() => evalIn(desktop, () => {
      const row = document.querySelector('[data-capability-call*="execute_capability"]');
      if (!row || row.querySelector('button[aria-expanded="true"]') === null) return false;
      const boundary = row.getBoundingClientRect();
      return [...row.querySelectorAll("pre")].some((element) => {
        const rect = element.getBoundingClientRect();
        return element.textContent?.includes("fixture identity") === true && rect.height > 0
          && rect.top >= 0 && rect.bottom <= innerHeight && rect.bottom <= boundary.bottom + 1;
      });
    }), { within: 30_000, label: "expanded actual tool output is visible, not only a running or collapsed row", until: Boolean });
    evidence.recordAssertionEvidence(`${memberName} actual rendered tool result`, "The existing execute_capability disclosure was opened once and its actual output pre contains fixture identity visibly in the viewport. No replacement JSON or synthetic UI was rendered.", true);
    await screenshot(desktop, { caption: `${memberName}: expanded actual MCP invocation and returned result after own native enrollment` });
  }
  const denied = await api(den.members.ungranted, "/v1/mcp-connections?scope=usable");
  expect(inventoryResponse.parse(denied.body).connections.some((entry: { id: string }) => entry.id === connectionId)).toBe(false);
  const log = await den.apiLog();
  expect(Object.values(keys).some((key) => log.includes(key))).toBe(false);
  expect(analyticsBodies.length).toBeGreaterThan(0);
  expect(Object.values(keys).some((key) => analyticsBodies.some((body) => body.includes(key)))).toBe(false);
  evidence.recordAssertionEvidence("Actual analytics request bodies omit candidates", `${analyticsBodies.length} actual requests captured at owned loopback analytics endpoint; zero matches for the two random synthetic PAT values. No bodies retained in artifacts.`, true);
  evidence.recordAssertionEvidence("Native Library/chat→real IPC→real Den", "One central connection, two ordinary native password enrollments with truthful stored-only success, then caller-specific actual tool requests. Ungranted member inventory excludes connection. Scoped transcript/DOM/URL/storage/app and API logs omit both synthetic values.", true);
});
