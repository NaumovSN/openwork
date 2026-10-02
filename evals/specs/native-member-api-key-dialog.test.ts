import { GlobalRegistrator } from "../../apps/app/node_modules/@happy-dom/global-registrator/lib/index.js";
import { afterAll, expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import type { MemberApiKeyBridge } from "@openwork/types/member-api-key";

vi.mock("../../apps/app/src/app/lib/den", () => ({ readDenSettings: () => ({ baseUrl: "https://app.example.test", authToken: "session", activeOrgId: "org_a" }) }));
GlobalRegistrator.register({ url: "https://desktop.example.test" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(() => GlobalRegistrator.unregister());
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemberApiKeyDialog, openMemberApiKeyDialog } = await import("../../apps/app/src/react-app/domains/connections/member-api-key-dialog.tsx");

test("reopening the same native connection never inherits saved state or input", async ({ evidence }) => {
  let count = 0;
  let release: ((value: Awaited<ReturnType<MemberApiKeyBridge["prepare"]>>) => void) | undefined;
  window.__OPENWORK_MEMBER_API_KEY__ = {
    prepare: async (connectionId) => {
      count++;
      if (count === 2) return new Promise((resolve) => { release = resolve; });
      return { ok: true, context: { handle: "handle_one", connectionId, connectionName: "Private tools", organizationId: "org_a", memberId: "member_a" } };
    },
    submit: async () => ({ ok: true, saved: true }),
    cancel: async () => undefined,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(MemberApiKeyDialog)); });
    await act(async () => { void openMemberApiKeyDialog("mcp_one"); });
    const input = document.querySelector("#member-api-key-input");
    if (!(input instanceof HTMLInputElement)) throw Error("Missing password field");
    expect(input.type).toBe("password");
    await act(async () => {
      input.value = "synthetic-only-value";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.body.textContent).toContain("Key saved");
    await act(async () => { void openMemberApiKeyDialog("mcp_one"); });
    expect(document.body.textContent).not.toContain("Key saved");
    expect(document.querySelector("#member-api-key-input")).toBeNull();
    expect(document.body.textContent).toContain("Checking your account");
    await act(async () => { release?.({ ok: true, context: { handle: "handle_two", connectionId: "mcp_one", connectionName: "Private tools", organizationId: "org_a", memberId: "member_a" } }); });
    const reopened = document.querySelector("#member-api-key-input");
    expect(reopened instanceof HTMLInputElement && reopened.value === "").toBe(true);
    expect(document.body.textContent).not.toContain("synthetic-only-value");
    evidence.recordAssertionEvidence("Same-id reopen is a fresh mounted prompt", "Previous success hidden during delayed prepare; fresh empty password field; no inherited saved status", true);
  } finally { await act(async () => root.unmount()); container.remove(); delete window.__OPENWORK_MEMBER_API_KEY__; }
});
