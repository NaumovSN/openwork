import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { UIMessage } from "ai";
import { messageNotice, projectedMessageMetadata, readRunActivities, runElapsed, sessionNotice } from "../src/lib/session-run";
import { transcriptProgress } from "../src/react-app/domains/session/status/session-progress";
import { agentInventory, agentResultVersion } from "../src/lib/agent-inventory";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { codeModeToolCalls } from "../src/lib/code-mode-tools";

test("resolved reply identity survives the shared projection with timing and terminal outcome", () => {
  const replyModel = { modelID: "served-model", providerID: "provider", name: "Served model", resolved: true };
  const metadata = projectedMessageMetadata({ time: { created: 1_000, completed: 8_000 }, parentID: "prompt",
    modelID: "requested-model", providerID: "provider", replyModel, error: { name: "MessageAbortedError" } });
  expect(metadata.opencode).toEqual({ created: 1_000, completed: 8_000, parentID: "prompt",
    model: { modelID: "requested-model", providerID: "provider" }, replyModel, outcome: "stopped" });
  expect(projectedMessageMetadata({ time: { created: 1_000 } }).opencode).not.toHaveProperty("replyModel");
});

afterEach(() => { setSystemTime(); useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} }); });

const task = (child: string, background = false): UIMessage => ({ id: `msg:${child}`, role: "assistant", parts: [{
  type: "dynamic-tool", toolName: "task", toolCallId: `call:${child}`, state: "input-available",
  input: { description: "Inspect a fixture", prompt: "Read the fixture", subagent_type: "general", background },
  callProviderMetadata: { openwork: { childSessionId: child, toolStartedAt: 1_000 } },
}] });

test("one admitted run survives a steering message and pauses for a human decision", () => {
  const store = useSessionActivityStore.getState();
  setSystemTime(1_000); store.beginRun("workspace", "parent", "prompt", 1_000);
  setSystemTime(2_000); store.observeTranscript("workspace", "parent", [{ id: "prompt", role: "user", parts: [] }, task("child")]);
  setSystemTime(3_000); store.beginRun("workspace", "parent", "steer", 3_000);
  store.observeTranscript("workspace", "parent", [{ id: "prompt", role: "user", parts: [] }, task("child"), { id: "steer", role: "user", parts: [] }]);
  store.setWaitingRequest("workspace", "parent", "question", "ask", true);
  setSystemTime(8_000); store.setWaitingRequest("workspace", "parent", "question", "ask", false);
  setSystemTime(10_000); store.setRunStatus("workspace", "parent", "idle");
  const record = useSessionActivityStore.getState().recordsByWorkspaceId.workspace!.parent!;
  expect(record.currentRunId).toBe("prompt");
  expect(runElapsed(record.runs.prompt!, 20_000)).toBe(4_000);
  expect(record.runs.prompt!.waiting).toEqual([{ start: 3_000, end: 8_000 }]);
});

test("a foreground child decision pauses the parent; a background decision does not", () => {
  const store = useSessionActivityStore.getState();
  setSystemTime(1_000); store.beginRun("w", "foreground", "fg", 1_000); store.beginRun("w", "background", "bg", 1_000);
  store.observeTranscript("w", "foreground", [task("child-fg")]); store.observeTranscript("w", "background", [task("child-bg", true)]);
  setSystemTime(2_000); store.setWaitingRequest("w", "child-fg", "permission", "fg-ask", true); store.setWaitingRequest("w", "child-bg", "permission", "bg-ask", true);
  setSystemTime(7_000);
  const records = useSessionActivityStore.getState().recordsByWorkspaceId.w!;
  expect(runElapsed(records.foreground!.runs.fg!, 7_000)).toBe(1_000);
  expect(runElapsed(records.background!.runs.bg!, 7_000)).toBe(6_000);
  store.setWaitingRequest("w", "child-fg", "permission", "fg-ask", false);
  expect(runElapsed(useSessionActivityStore.getState().recordsByWorkspaceId.w!.foreground!.runs.fg!, 8_000)).toBe(2_000);
});

test("a locally admitted steering prompt keeps the restored busy run and its elapsed time", () => {
  const store = useSessionActivityStore.getState();
  setSystemTime(1_000);
  store.seedSessionRun("restored", "parent", { type: "busy" }, undefined, { snapshotStartedAt: 1_000 });
  store.observeTranscript("restored", "parent", [{ id: "prompt", role: "user", parts: [], metadata: { opencode: { created: 1_000 } } }, task("child")]);
  const before = useSessionActivityStore.getState().recordsByWorkspaceId.restored!.parent!;
  setSystemTime(3_000);
  store.beginRun("restored", "parent", "steer", 3_000);
  store.observeTranscript("restored", "parent", [{ id: "prompt", role: "user", parts: [] }, task("child"), { id: "steer", role: "user", parts: [] }]);
  const after = useSessionActivityStore.getState().recordsByWorkspaceId.restored!.parent!;
  expect(after.currentRunId).toBe(before.currentRunId);
  expect(after.runStartedAt).toBe(before.runStartedAt);
  expect(runElapsed(after.runs[after.currentRunId!]!, 4_000)).toBe(3_000);
  expect(after.runs[after.currentRunId!]!.promptIds).toContain("steer");
});

test("only allowlisted native notices appear and an idle-parent continuation anchors to its notice", () => {
  const native = { source: "subagent", childID: "child", state: "completed", description: "Inspect a fixture" };
  expect(sessionNotice({ source: "instruction", state: "completed" }, "hidden", 1_000)).toBeNull();
  expect(sessionNotice({ source: "subagent", childID: "child", state: "running" }, "hidden", 1_000)).toBeNull();
  const notice = sessionNotice(native, "native-notice", 2_000)!;
  const message: UIMessage = { id: notice.id, role: "assistant", parts: [{ type: "text", text: "Hidden model input", providerMetadata: { opencode: { notice } } }] };
  expect(messageNotice(message)).toEqual(notice);
  setSystemTime(3_000);
  const store = useSessionActivityStore.getState();
  store.observeTranscript("w", "parent", [message]); store.setRunStatus("w", "parent", "busy");
  store.observeTranscript("w", "parent", [message]);
  const record = useSessionActivityStore.getState().recordsByWorkspaceId.w!.parent!;
  expect(record.currentRunId).toBe(notice.id);
  expect(record.runs[notice.id]!.startedAt).toBe(2_000);
  expect(Object.keys(record.runs)).toEqual([notice.id]);
});

test("inventory includes historical children and verified descendants, protects cycles, and result versions ignore polls", () => {
  const parts = agentInventory("parent", [task("old-child")], {
    parent: { childSessionIds: ["old-child"], runStartedAt: 0 },
    "old-child": { childSessionIds: ["grandchild", "parent"], runStartedAt: 1_000 },
    grandchild: { childSessionIds: ["old-child"], runStartedAt: 2_000 },
  });
  expect(parts).toHaveLength(2);
  const part = parts[0]!;
  expect(agentResultVersion(part, { runStatusAt: 9_000, runActive: false })).toBeNull();
  const settled = { ...part, state: "output-available" as const, output: "Fixture read" };
  expect(agentResultVersion(settled, { runStatusAt: 9_000, runActive: false })).toBe(agentResultVersion(settled, { runStatusAt: 20_000, runActive: false }));
});

test("parallel repeated calls only receive the result for their invocation ordinal", () => {
  const part = { type: "dynamic-tool" as const, toolName: "execute", toolCallId: "outer", state: "output-available" as const, input: {}, output: "Done",
    callProviderMetadata: { openwork: { codeMode: { calls: [
      { tool: "tracker.search", status: "completed", input: { query: "one" } },
      { tool: "tracker.search", status: "completed", input: { query: "two" } },
    ], details: [
      { tool: "tracker.search", ordinal: 1, output: "second result", startedAt: 1_000, endedAt: 2_000 },
      { tool: "other.search", ordinal: 0, output: "wrong result" },
    ] } } } };
  expect(codeModeToolCalls(part)?.map(call => call.state === "output-available" ? call.output : null)).toEqual([undefined, "second result"]);
});

test("pinned v2 dotted calls receive underscored enrichment only for their outer invocation", () => {
  const part = { type: "dynamic-tool" as const, toolName: "execute", toolCallId: "outer", state: "output-available" as const, input: {}, output: "Done",
    callProviderMetadata: { openwork: { codeMode: { calls: [
      { tool: "openwork-cloud.execute_capability", status: "completed", input: { name: "first" } },
      { tool: "openwork-cloud.execute_capability", status: "completed", input: { name: "second" } },
    ], details: [
      { invocationId: "outer:0", tool: "openwork-cloud_execute_capability", ordinal: 0, output: "first result" },
      { invocationId: "another-outer:1", tool: "openwork-cloud_execute_capability", ordinal: 1, output: "wrong execution" },
    ] } } } };
  expect(codeModeToolCalls(part)?.map(call => call.state === "output-available" ? call.output : null)).toEqual(["first result", undefined]);
});

test("waiting intervals overlap only once and invalid persisted timing stays unavailable", () => {
  expect(runElapsed({ id: "run", startedAt: 1_000, endedAt: 10_000,
    waiting: [{ start: 2_000, end: 5_000 }, { start: 3_000, end: 6_000 }] }, 20_000)).toBe(5_000);
  expect(readRunActivities({ broken: { id: "broken", startedAt: 100, waiting: [{ start: 80 }] } })).toEqual({});
  const valid = { id: "run", startedAt: 1_000, waiting: [{ start: 2_000, end: 5_000 }] };
  expect(readRunActivities({ run: valid })).toEqual({ run: valid });
});

test("nested content and lifecycle are progress, but elapsed ticks are not", () => {
  const project = (status: string, endedAt: number): UIMessage[] => [{ id: "assistant", role: "assistant", parts: [{
    type: "dynamic-tool", toolName: "execute", toolCallId: "outer", state: "input-streaming", input: { code: "recorded" },
    callProviderMetadata: { openwork: { toolStartedAt: 1_000, toolEndedAt: endedAt, codeMode: {
      calls: [{ tool: "service.search", status, input: { query: "fixture" } }],
      details: [{ tool: "service.search", ordinal: 0, startedAt: 1_000, endedAt, output: "Exact fixture result" }],
    } } },
  }] }];
  const first = transcriptProgress(project("running", 2_000));
  const tick = transcriptProgress(project("running", 3_000), first.parts);
  expect(tick.revision).toBe(first.revision);
  expect(tick.label).toBeNull();
  const completed = transcriptProgress(project("completed", 3_000), tick.parts);
  expect(completed.revision).not.toBe(tick.revision);
  expect(completed.label).toBe("Using a tool");
});

test("timing persists under the history owner and does not cross an account or server boundary", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  } });
  try {
    const store = useSessionActivityStore.getState();
    setSystemTime(1_000); store.bindRunTimingScope("scope-workspace", "session", "account-a:server-a:session");
    store.beginRun("scope-workspace", "session", "prompt", 1_000);
    setSystemTime(2_000); store.setWaitingRequest("scope-workspace", "session", "question", "request", true);
    setSystemTime(5_000); store.setWaitingRequest("scope-workspace", "session", "question", "request", false);
    const saved = JSON.parse(items.get("openwork:run-timing:account-a:server-a:session")!);
    expect(saved.runs.prompt.waiting).toEqual([{ start: 2_000, end: 5_000 }]);
    setSystemTime(6_000); store.bindRunTimingScope("scope-workspace", "session", "account-b:server-b:session");
    const other = useSessionActivityStore.getState().recordsByWorkspaceId["scope-workspace"]!.session!;
    expect(other.runs.prompt).toBeUndefined();
    expect(other.currentRunId).not.toBe("prompt");
    expect(JSON.parse(items.get("openwork:run-timing:account-a:server-a:session")!).runs.prompt.waiting).toEqual(saved.runs.prompt.waiting);
    expect(items.has("openwork:run-timing:scope-workspace:session")).toBe(false);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a failed steering admission leaves the original run and its prompt ownership intact", () => {
  const store = useSessionActivityStore.getState();
  setSystemTime(1_000); store.beginRun("w", "p", "first", 1_000);
  store.beginRun("w", "p", "uncertain-followup", 2_000);
  store.cancelUnadmittedRun("w", "p", "uncertain-followup");
  const record = useSessionActivityStore.getState().recordsByWorkspaceId.w!.p!;
  expect(record.currentRunId).toBe("first");
  expect(record.runs.first!.promptIds).toEqual(["first"]);
  expect(record.runActive).toBe(true);
});

test("a native notice during work joins the current run without changing its timer", () => {
  setSystemTime(1_000);
  const store = useSessionActivityStore.getState();
  store.beginRun("notice-w", "parent", "original-prompt", 1_000);
  const notice = sessionNotice({ source: "subagent", childID: "child", state: "completed" }, "notice", 2_000)!;
  const message: UIMessage = { id: notice.id, role: "assistant", parts: [{ type: "text", text: "Native completion", providerMetadata: { opencode: { notice } } }] };
  setSystemTime(3_000); store.observeTranscript("notice-w", "parent", [message]);
  store.observeTranscript("notice-w", "parent", [message]);
  const record = useSessionActivityStore.getState().recordsByWorkspaceId["notice-w"]!.parent!;
  expect(record.currentRunId).toBe("original-prompt");
  expect(record.runs["original-prompt"]!.noticeIds).toEqual(["notice"]);
  expect(runElapsed(record.runs["original-prompt"]!, 4_000)).toBe(3_000);
});
