import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { connect, debuggerUrlFor, listTargets, type Surface } from "@openwork/cdp";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { resolveEvalEngine, SkipError, type Place, type Seed } from "@openwork/env";
import { slackFixtureClientId, slackFixtureClientSecret, slackFixtureWorkspace, startNativeSlackFixture } from "../packages/labs/src/mock-native-slack.ts";
import { slackIncomplete, slackLimited, slackResultObjects, slackSearchHits, startNativeSlackModel } from "../packages/labs/src/native-slack-model.ts";

export const nativeSlackPrompts = {
  first: "Find the Amber launch discussion in Slack, include my private conversations and direct messages, and read a short thread excerpt with source links.",
  second: "Find the Amber launch discussion in my Slack account and summarize a short thread excerpt with source links.",
  partial: "Find the Amber launch discussion using my remaining Slack access and explain which conversations were not searched.",
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a native Slack response object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a native Slack response string");
  return value;
}
function rpc(raw: string): Record<string, unknown> {
  const line = raw.split("\n").find(entry => entry.startsWith("data:"));
  const envelope = object(JSON.parse(line ? line.slice(5) : raw));
  if (envelope.error) throw new Error("Cloud MCP returned a protocol error");
  return object(envelope.result);
}

/**
 * Browser-representable desktop UX with real app/server/engine and hosted
 * Connect. Only Slack OAuth/API and inference are synthetic. No BYO connector
 * is created. A second Den process borrows ONLY this world's scratch database:
 * the original gate-off process proves retained-token rejection without a
 * mutable production flag, DB credential injection, or product-code shim.
 */
export async function nativeSlackConnect(seed: Seed, { place }: { place: Place }) {
  // The native HTTP fixture is loopback, unlike mcpMock's remote transport.
  // Do not silently run a Daytona world against the developer's local server.
  if (place.kind !== "local" || process.env.OPENWORK_EVAL_DEN_API_URL) {
    throw new SkipError("isolated co-located native Slack HTTP fixture; testkit has no Daytona native-provider transport");
  }
  // The build manifest supplies the independent version pin, not a synthesized runtime result.
  const versions = object(JSON.parse(await readFile(new URL("../../constants.json", import.meta.url), "utf8")));
  const engine = resolveEvalEngine();
  const engineVersion = text(versions[engine === "v2" ? "opencodeV2Version" : "opencodeVersion"]);
  await using setup = new AsyncDisposableStack();
  const slack = setup.use(await startNativeSlackFixture());
  const model = setup.use(await startNativeSlackModel(Object.values(nativeSlackPrompts)));
  const preload = new URL("../packages/labs/src/native-slack-egress.mjs", import.meta.url);
  const isolated = { NODE_OPTIONS: `--import=${preload.href}`, NODE_ENV: "test", OPENWORK_DEV_MODE: "1", RESEND_API_KEY: "", SMTP_HOST: "", SENTRY_DSN: "", DEN_SLACK_SIGNING_SECRET: "", DEN_SLACK_BOT_TOKEN: "" };
  const gateOff = await seed.den({ web: false, org: { name: "ENG-76 synthetic internal", members: { first: {}, second: {} } }, env: {
    ...isolated, DEN_SLACK_ENABLED: "false", DEN_SLACK_ORGANIZATION_ID: "", DEN_SLACK_WORKSPACE_ID: "",
    DEN_SLACK_CLIENT_ID: "", DEN_SLACK_CLIENT_SECRET: "", DEN_SLACK_API_BASE_URL: slack.apiUrl,
    DEN_SLACK_OAUTH_AUTHORIZE_URL: slack.authorizeUrl, DEN_SLACK_OAUTH_TOKEN_URL: slack.tokenUrl,
  } });
  const database = gateOff.database;
  if (!database || !database.name.startsWith("openwork_eval")) {
    throw new Error("Synthetic Slack requires the testkit-owned scratch database; refusing a shared database");
  }
  const organization = object(object((await seed.api(gateOff.admin, "/v1/org")).body).organization);
  const organizationId = text(organization.id);
  const other = await seed.api(gateOff.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "ENG-76 synthetic blocked organization" }) });
  if (!other.response.ok) throw new Error("Could not arrange the synthetic blocked organization");
  const blockedOrganizationId = text(object(object(other.body).organization).id);
  const enabled = await seed.den({ web: false, provision: false, env: {
    ...isolated, DATABASE_URL: database.url,
    DEN_SLACK_ENABLED: "true", DEN_SLACK_ORGANIZATION_ID: organizationId, DEN_SLACK_WORKSPACE_ID: slackFixtureWorkspace,
    DEN_SLACK_CLIENT_ID: slackFixtureClientId, DEN_SLACK_CLIENT_SECRET: slackFixtureClientSecret,
    DEN_SLACK_API_BASE_URL: slack.apiUrl, DEN_SLACK_OAUTH_AUTHORIZE_URL: slack.authorizeUrl, DEN_SLACK_OAUTH_TOKEN_URL: slack.tokenUrl,
  } });
  slack.allowCallbackOrigin(enabled.ref.apiUrl);
  const first = gateOff.members.first;
  const second = gateOff.members.second;
  if (!first || !second) throw new Error("Both synthetic members must be provisioned");
  const sessions = {
    first: { ...first, ...enabled.ref }, second: { ...second, ...enabled.ref },
    blocked: { ...gateOff.admin, ...enabled.ref },
  };
  const orgFor = (identity: keyof typeof sessions) => identity === "blocked" ? blockedOrganizationId : organizationId;
  const memberRequest = async (identity: keyof typeof sessions, path: string, method = "GET", body?: unknown, disabled = false) => {
    const session = disabled ? { ...sessions[identity], ...gateOff.ref } : sessions[identity];
    const result = await denFetch(session, path, { method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgFor(identity) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return { status: result.response.status, body: result.body, text: result.text };
  };
  async function mint(identity: keyof typeof sessions, disabled = false): Promise<DenSession> {
    const result = await memberRequest(identity, "/v1/mcp/token", "POST", { scopes: ["mcp:read"] }, disabled);
    if (result.status !== 200) throw new Error(`Synthetic member MCP mint failed: ${result.status}`);
    const minted = object(result.body);
    if (!Array.isArray(minted.scopes) || minted.scopes.length !== 1 || minted.scopes[0] !== "mcp:read") {
      throw new Error("The proof requires an actually minted mcp:read-only token");
    }
    return { ...sessions[identity], ...(disabled ? gateOff.ref : {}), token: text(minted.token) };
  }
  const tokens = { first: await mint("first"), second: await mint("second"), blocked: await mint("blocked") };
  // Each deployment needs its own valid audience-bound bearer. A wrong-audience
  // rejection would not witness the Slack rollout policy at all.
  const disabledTokens = { first: await mint("first", true), second: await mint("second", true), blocked: await mint("blocked", true) };
  const makeApp = async (identity: "first" | "second") => {
    const directory = seed.tmpPath(`native-slack-${identity}`);
    await mkdir(directory, { recursive: true });
    const workspacePath = await realpath(directory);
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({
      permission: { skill: "allow" }, model: "opencode/big-pickle", small_model: "opencode/big-pickle",
      provider: { opencode: { npm: "@ai-sdk/openai-compatible", options: { baseURL: model.url, apiKey: "synthetic-model-key" }, whitelist: ["big-pickle"],
        models: { "big-pickle": { name: "Big Pickle", tool_call: true, provider: { npm: "@ai-sdk/openai-compatible", api: model.url } } } } },
      mcp: { "openwork-cloud": { type: "remote", url: `${enabled.ref.apiUrl}/mcp/agent`, oauth: false, enabled: true, headers: { Authorization: `Bearer ${tokens[identity].token}` } } },
    }));
    const app = await seed.appWeb({ name: `native-slack-${identity}`, workspacePath, headless: true, env: {
      OPENCODE_MODELS_URL: `${model.url}/models`,
      ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    } });
    await app.client.send("Network.enable");
    await app.client.send("Network.setBlockedURLs", { urls: ["*://slack.com/*", "*://*.slack.com/*"] });
    await seed.signIn(app, sessions[identity], identity);
    const workspace = await seed.workspace(app, workspacePath);
    // App-web has no Electron desktopApi bridge. Reuse the owned-runtime public
    // HTTP witness used by engine-parity; this token never enters prompts/evidence.
    const runtimePaths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
    const manifest = await readHeadlessRuntimeManifest(runtimePaths.runtimeManifestPath);
    if (!manifest) throw new Error("Missing the test-owned app runtime manifest");
    const ownerResponse = await fetch(`${app.openworkUrl}/tokens`, {
      method: "POST", redirect: "error", headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "owner", label: "eng-76-runtime-witness" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (ownerResponse.status !== 201) throw new Error("Could not authorize the test-owned runtime witness");
    const ownerToken = text(object(await ownerResponse.json()).token);
    const request = async (path: string) => {
      const response = await fetch(`${app.openworkUrl}${path}`, {
        headers: { Authorization: `Bearer ${ownerToken}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    };
    return { app, workspace, request };
  };
  const memberOne = await makeApp("first");
  const memberTwo = await makeApp("second");
  const attached = new Set<string>();
  let rpcId = 0;
  const resources = setup.move();
  return {
    app: memberOne.app, secondApp: memberTwo.app, slack, model, engine, engineVersion, first: sessions.first, second: sessions.second,
    organizationId, blockedOrganizationId, workspaceId: memberOne.workspace.workspaceId, memberRequest, searchHits: slackSearchHits, incomplete: slackIncomplete, limited: slackLimited, objects: slackResultObjects,
    prompt: nativeSlackPrompts,
    appRequest(identity: "first" | "second", path: string) {
      return (identity === "first" ? memberOne : memberTwo).request(path);
    },
    appUrl: new URL(`#/workspace/${memberOne.workspace.workspaceId}/session`, memberOne.app.webUrl).toString(),
    async connection(identity: "first" | "second") {
      const result = await memberRequest(identity, "/v1/mcp-connections?scope=usable");
      if (result.status !== 200) throw new Error(`Native connection list failed: ${result.status}`);
      return slackResultObjects(result.body).find(entry => entry.id === "slack");
    },
    async oauthSurface(app: Surface): Promise<Surface> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const target = (await listTargets(app.handle.cdpUrl)).find(entry => entry.type === "page" && !attached.has(entry.id) && entry.url.startsWith(slack.authorizeUrl));
        if (target) {
          attached.add(target.id);
          const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
          resources.defer(() => client.close());
          return { handle: app.handle, client };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Connect did not open an observable loopback Slack OAuth page; no real provider was contacted");
    },
    async startAuthorization(identity: "first" | "second") {
      const started = await memberRequest(identity, "/v1/oauth-providers/slack/connect/start");
      if (started.status !== 200) throw new Error(`Native OAuth start failed: ${started.status}`);
      const authorizeUrl = new URL(text(object(started.body).authorizeUrl));
      if (authorizeUrl.origin !== slack.origin) throw new Error("Refusing a non-synthetic Slack authorization URL");
      return authorizeUrl.toString();
    },
    async mcp(identity: keyof typeof sessions, name: string, args: Record<string, unknown>, disabled = false) {
      const session = disabled ? disabledTokens[identity] : tokens[identity];
      const result = await denFetch(session, "/mcp/agent", { method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(30_000) });
      return { status: result.response.status, body: result.response.ok ? rpc(result.text) : result.body };
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
