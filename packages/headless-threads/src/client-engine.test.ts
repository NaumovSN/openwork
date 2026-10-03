import { describe, expect, test } from "bun:test";

import { createHeadlessThreadClient } from "./client.js";
import { HeadlessThreadError } from "./errors.js";
import type { HeadlessFetch, HeadlessThreadClientOptions } from "./types.js";

type Recorded = { method: string; path: string; body: unknown };

const SESSION_ID = "ses_1";
const V2 = "/workspace/ws_1/opencode2/api";
const V1 = "/workspace/ws_1/opencode";

const v2Session = {
  id: SESSION_ID,
  title: "Weekly report",
  location: { directory: "/workspace" },
  time: { created: 1, updated: 1 },
};

/**
 * A stand-in OpenWork server with both engine mounts. `engineStatus` scripts
 * the routing answer; `defaultModel` scripts the workspace default.
 */
function createServerDouble(input: {
  engineStatus: number | { enabled: boolean; chatRouting: boolean } | Array<number | { enabled: boolean; chatRouting: boolean }>;
  defaultModel?: number | { providerID: string; modelID: string; variant?: string } | null;
  sessionModel?: { providerID: string; id: string };
  messagePages?: Array<{ data: unknown[]; cursor?: { next?: string | null } }>;
  active?: Record<string, { type: string }>;
  interrupted?: boolean;
}) {
  const requests: Recorded[] = [];
  const statuses = Array.isArray(input.engineStatus) ? input.engineStatus : [input.engineStatus];
  let statusReads = 0;

  const fetchImpl: HeadlessFetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const path = `${parsed.pathname}${parsed.search}`;
    requests.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body) });

    if (parsed.pathname === "/experimental/engine-v2-preview/status") {
      const status = statuses[Math.min(statusReads, statuses.length - 1)];
      statusReads += 1;
      return typeof status === "number"
        ? Response.json({ code: "unavailable", message: "Status unavailable" }, { status })
        : Response.json({ ...status, running: status.enabled, migration: { state: "idle" } });
    }
    if (parsed.pathname === "/workspace/ws_1/default-model") {
      const model = input.defaultModel;
      if (typeof model === "number") return Response.json({ code: "not_found" }, { status: model });
      return Response.json({ model: model ?? null, updatedAt: model ? 1 : null });
    }
    if (method === "POST" && parsed.pathname === `${V2}/session`) {
      return Response.json({ data: v2Session });
    }
    if (method === "GET" && parsed.pathname === `${V2}/session/active`) {
      return Response.json({ data: input.active ?? {} });
    }
    if (method === "GET" && parsed.pathname === `${V2}/session/${SESSION_ID}`) {
      return Response.json({ data: { ...v2Session, ...(input.sessionModel ? { model: input.sessionModel } : {}) } });
    }
    if (method === "GET" && parsed.pathname === `${V2}/session/${SESSION_ID}/message`) {
      const pages = input.messagePages ?? [{ data: [], cursor: {} }];
      const cursor = parsed.searchParams.get("cursor");
      const index = cursor === null ? 0 : Number(cursor.replace("page_", ""));
      return Response.json(pages[index] ?? { data: [], cursor: {} });
    }
    if (method === "POST" && parsed.pathname === `${V2}/session/${SESSION_ID}/model`) {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && parsed.pathname === `${V2}/session/${SESSION_ID}/prompt`) {
      return Response.json({ data: { id: "inp_1", sessionID: SESSION_ID } });
    }
    if (method === "POST" && parsed.pathname === `${V2}/session/${SESSION_ID}/interrupt`) {
      return Response.json({ data: { interrupted: input.interrupted ?? true } });
    }
    if (method === "POST" && parsed.pathname === `${V1}/session`) {
      return Response.json({ id: SESSION_ID, title: "Weekly report", directory: "/workspace", time: { created: 1 } });
    }
    if (method === "GET" && parsed.pathname === `${V1}/session/${SESSION_ID}/message`) {
      return Response.json([]);
    }
    if (method === "POST" && parsed.pathname === `${V1}/session/${SESSION_ID}/prompt_async`) {
      return new Response(null, { status: 204 });
    }
    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  };

  return {
    fetchImpl,
    requests,
    statusReads: () => statusReads,
    calls: () => requests.map(({ method, path }) => `${method} ${path}`),
  };
}

function createClient(double: ReturnType<typeof createServerDouble>, options?: Partial<HeadlessThreadClientOptions>) {
  return createHeadlessThreadClient({
    baseUrl: "http://openwork.test",
    workspaceId: "ws_1",
    token: "owt_test",
    fetch: double.fetchImpl,
    now: () => 0,
    sleep: async () => {},
    ...options,
  });
}

const MODEL = { providerId: "anthropic", modelId: "claude-sonnet-5" };
const V2_ON = { enabled: true, chatRouting: true };

describe("engine detection", () => {
  test("routes to v2 when the server's chats use it, and asks only once", async () => {
    const double = createServerDouble({ engineStatus: V2_ON });
    const client = createClient(double, { defaultModel: MODEL });

    const thread = await client.createThread({ title: "Weekly report" });
    await client.getThreadSnapshot(SESSION_ID);

    expect(thread.engine).toBe("v2");
    expect(double.statusReads()).toBe(1);
    expect(double.calls()).toContain(`POST ${V2}/session`);
    expect(double.calls().some((call) => call.includes("/opencode/"))).toBe(false);
  });

  test("stays on v1 while v2 is installed but not routing chats", async () => {
    const double = createServerDouble({ engineStatus: { enabled: true, chatRouting: false } });

    const thread = await createClient(double).createThread({ title: "Weekly report" });

    expect(thread.engine).toBe("v1");
    expect(double.calls()).toContain(`POST ${V1}/session`);
  });

  test("treats a server without the status route as v1", async () => {
    const double = createServerDouble({ engineStatus: 404 });

    const thread = await createClient(double).createThread({ title: "Weekly report" });

    expect(thread.engine).toBe("v1");
    expect(double.calls()).toEqual(["GET /experimental/engine-v2-preview/status", `POST ${V1}/session`]);
  });

  test("refuses to guess v1 when the status read fails, and retries on the next call", async () => {
    const double = createServerDouble({ engineStatus: [500, V2_ON] });
    const client = createClient(double, { defaultModel: MODEL });

    const error = await client.createThread({ title: "Weekly report" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HeadlessThreadError);
    if (!(error instanceof HeadlessThreadError)) throw new Error("expected a HeadlessThreadError");
    expect(error.code).toBe("engine_unresolved");
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
    expect(double.calls()).toEqual(["GET /experimental/engine-v2-preview/status"]);

    const thread = await client.createThread({ title: "Weekly report" });
    expect(thread.engine).toBe("v2");
    expect(double.statusReads()).toBe(2);
  });

  test("an explicit engine skips the status read", async () => {
    const double = createServerDouble({ engineStatus: 500 });

    await createClient(double, { engine: "v2", defaultModel: MODEL }).createThread({ title: "Weekly report" });

    expect(double.statusReads()).toBe(0);
  });
});

describe("v2 transport", () => {
  test("creates with the model, sets it on the session, then prompts", async () => {
    const double = createServerDouble({ engineStatus: V2_ON });

    const thread = await createClient(double).createThread({
      title: "Weekly report",
      prompt: "Summarize this week.",
      model: { ...MODEL, variant: "thinking" },
    });

    expect(double.requests.slice(1)).toEqual([
      { method: "POST", path: `${V2}/session`, body: { title: "Weekly report", model: { providerID: "anthropic", id: "claude-sonnet-5" } } },
      { method: "POST", path: `${V2}/session/${SESSION_ID}/model`, body: { model: { providerID: "anthropic", id: "claude-sonnet-5", variant: "thinking" } } },
      { method: "POST", path: `${V2}/session/${SESSION_ID}/prompt`, body: { text: "Summarize this week." } },
    ]);
    expect(thread).toEqual({
      id: SESSION_ID,
      workspaceId: "ws_1",
      title: "Weekly report",
      directory: "/workspace",
      createdAt: 1,
      started: true,
      engine: "v2",
      model: { ...MODEL, variant: "thinking" },
    });
  });

  test("maps paged v2 history into the snapshot, oldest first", async () => {
    const double = createServerDouble({
      engineStatus: V2_ON,
      active: { [SESSION_ID]: { type: "running" } },
      messagePages: [
        {
          data: [
            {
              id: "msg_3",
              type: "assistant",
              time: { created: 3 },
              content: [
                { type: "reasoning", id: "r_1", text: "Thinking." },
                { type: "tool", id: "call_1", name: "read", state: { status: "completed" } },
                { type: "text", id: "t_1", text: "Done." },
              ],
              cost: 0.5,
              tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 1, write: 0 } },
            },
            { id: "msg_2", type: "model-switched", time: { created: 2 }, model: { providerID: "anthropic", id: "claude-sonnet-5" } },
          ],
          cursor: { next: "page_1" },
        },
        { data: [{ id: "msg_1", type: "user", time: { created: 1 }, text: "Summarize." }], cursor: { next: null } },
      ],
    });

    const snapshot = await createClient(double).getThreadSnapshot(SESSION_ID);

    expect(snapshot).toEqual({
      threadId: SESSION_ID,
      title: "Weekly report",
      directory: "/workspace",
      status: { type: "busy" },
      todos: [],
      messages: [
        {
          id: "msg_1",
          role: "user",
          parentId: null,
          createdAt: 1,
          error: null,
          usage: null,
          parts: [{ id: "msg_1:0", type: "text", text: "Summarize." }],
        },
        {
          id: "msg_3",
          role: "assistant",
          parentId: "msg_1",
          createdAt: 3,
          error: null,
          usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, cost: 0.5 },
          parts: [
            { id: "r_1", type: "reasoning", text: "Thinking." },
            { id: "call_1", type: "tool", tool: "read", callId: "call_1", toolStatus: "completed" },
            { id: "t_1", type: "text", text: "Done." },
          ],
        },
      ],
    });
    expect(double.calls()).toContain(`GET ${V2}/session/${SESSION_ID}/message?limit=200&cursor=page_1`);
  });

  test("surfaces a failed v2 assistant turn as the wait's terminal error", async () => {
    const double = createServerDouble({
      engineStatus: V2_ON,
      messagePages: [{
        data: [
          { id: "msg_2", type: "assistant", time: { created: 2 }, content: [], error: { type: "unknown", message: "Provider rejected the key." } },
          { id: "msg_1", type: "user", time: { created: 1 }, text: "Go." },
        ],
        cursor: {},
      }],
    });

    const result = await createClient(double).waitForThread(SESSION_ID, { timeoutMs: 1_000 });

    expect(result.outcome).toBe("failed");
    expect(result.terminalError).toEqual({ name: "UnknownError", message: "Provider rejected the key.", retryable: null });
  });

  test("interrupts to abort and reports the engine's answer", async () => {
    const double = createServerDouble({ engineStatus: V2_ON, interrupted: false });

    await expect(createClient(double).abortThread(SESSION_ID)).resolves.toEqual({ threadId: SESSION_ID, accepted: false });
    expect(double.requests.at(-1)).toEqual({ method: "POST", path: `${V2}/session/${SESSION_ID}/interrupt`, body: {} });
  });

  test("a follow-up keeps the session's own model when no other is known", async () => {
    const double = createServerDouble({
      engineStatus: V2_ON,
      defaultModel: 404,
      sessionModel: { providerID: "openai", id: "gpt-5" },
    });

    const accepted = await createClient(double).sendTurn(SESSION_ID, { prompt: "And next week?", messageId: "msg_run_1" });

    expect(accepted).toMatchObject({ messageCountBefore: 0, messageId: "msg_run_1", alreadyPresent: false });
    expect(double.calls().filter((call) => call.startsWith("POST"))).toEqual([`POST ${V2}/session/${SESSION_ID}/prompt`]);
  });

  test("a v2 turn carries the caller's message id, so the engine admits a retry once", async () => {
    const double = createServerDouble({
      engineStatus: V2_ON,
      defaultModel: 404,
      sessionModel: { providerID: "openai", id: "gpt-5" },
    });

    await createClient(double).sendTurn(SESSION_ID, { prompt: "And next week?", messageId: "msg_run_1" });

    expect(double.requests.at(-1)).toMatchObject({
      path: `${V2}/session/${SESSION_ID}/prompt`,
      body: { text: "And next week?", id: "msg_run_1" },
    });
  });
});

describe("default model", () => {
  test("uses the workspace default when a call names no model", async () => {
    const double = createServerDouble({ engineStatus: V2_ON, defaultModel: { providerID: "openai", modelID: "gpt-5", variant: "high" } });

    const thread = await createClient(double).createThread({ title: "Weekly report", prompt: "Go." });

    expect(thread.model).toEqual({ providerId: "openai", modelId: "gpt-5", variant: "high" });
    expect(double.requests.find((request) => request.path === `${V2}/session/${SESSION_ID}/model`)?.body)
      .toEqual({ model: { providerID: "openai", id: "gpt-5", variant: "high" } });
  });

  test("passes the workspace default to v1 prompts", async () => {
    const double = createServerDouble({ engineStatus: 404, defaultModel: { providerID: "openai", modelID: "gpt-5" } });

    await createClient(double).sendTurn(SESSION_ID, { prompt: "Go." });

    expect(double.requests.at(-1)?.body).toEqual({
      parts: [{ type: "text", text: "Go." }],
      model: { providerID: "openai", modelID: "gpt-5" },
    });
  });

  test("v1 without any model still sends, leaving the choice to the engine", async () => {
    const double = createServerDouble({ engineStatus: 404, defaultModel: 404 });

    const thread = await createClient(double).createThread({ title: "Weekly report", prompt: "Go." });

    expect(thread.model).toBeUndefined();
    expect(double.requests.at(-1)?.body).toEqual({ parts: [{ type: "text", text: "Go." }] });
  });

  test("v2 without any model refuses before creating a session", async () => {
    const double = createServerDouble({ engineStatus: V2_ON, defaultModel: null });

    const error = await createClient(double).createThread({ title: "Weekly report", prompt: "Go." }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HeadlessThreadError);
    if (!(error instanceof HeadlessThreadError)) throw new Error("expected a HeadlessThreadError");
    expect(error.code).toBe("model_required");
    expect(error.retryable).toBe(false);
    expect(double.calls().some((call) => call.startsWith("POST"))).toBe(false);
  });

  test("an explicit model skips the lookup", async () => {
    const double = createServerDouble({ engineStatus: V2_ON, defaultModel: 500 });

    await createClient(double).createThread({ title: "Weekly report", prompt: "Go.", model: MODEL });

    expect(double.calls().some((call) => call.includes("/default-model"))).toBe(false);
  });
});
