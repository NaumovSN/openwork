import { GlobalRegistrator } from "../../ee/apps/den-web/node_modules/@happy-dom/global-registrator/lib/index.js";
import type { Root } from "react-dom/client";
import type { QueryClient as QueryClientType } from "../../ee/apps/den-web/node_modules/@tanstack/react-query/build/modern/index.js";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import { MEMBER_API_KEY_UNCERTAIN_MESSAGE } from "../../ee/apps/den-web/app/(den)/dashboard/_components/member-api-key.ts";
import type { MemberApiKeyTarget } from "../../ee/apps/den-web/app/(den)/dashboard/_components/member-api-key-dialog.tsx";

const mockState = vi.hoisted(() => {
  let organizationId = "org_a";
  let request = async (..._args: unknown[]): Promise<{ response: Response; payload: unknown }> => ({
    response: new Response("{}", { status: 200 }),
    payload: {},
  });
  return {
    getOrganizationId: () => organizationId,
    reset: () => {
      organizationId = "org_a";
      request = async () => ({ response: new Response("{}", { status: 200 }), payload: {} });
    },
    runRequest: (...args: unknown[]) => request(...args),
    setOrganizationId: (value: string) => { organizationId = value; },
    setRequest: (value: typeof request) => { request = value; },
  };
});

vi.mock("../../ee/apps/den-web/app/(den)/dashboard/_providers/org-dashboard-provider", () => ({
  useOrgDashboard: () => ({ orgId: mockState.getOrganizationId() }),
}));

vi.mock("../../ee/apps/den-web/app/(den)/_lib/den-flow", () => ({
  DenRequestCanceledError: class DenRequestCanceledError extends Error {},
  DenRequestTimeoutError: class DenRequestTimeoutError extends Error {},
  getRequestError: () => new Error("safe request failure"),
  isReauthRequiredError: () => false,
  requestJson: (...args: unknown[]) => mockState.runRequest(...args),
}));

GlobalRegistrator.register({ url: "https://app.example.test/dashboard/your-connections" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(() => GlobalRegistrator.unregister());
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("../../ee/apps/den-web/node_modules/@tanstack/react-query/build/modern/index.js");
const { MemberApiKeyDialog } = await import("../../ee/apps/den-web/app/(den)/dashboard/_components/member-api-key-dialog.tsx");

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function response(status: number) {
  return { response: new Response("{}", { status }), payload: {} };
}

function signalFromRequestArgs(args: unknown[]): AbortSignal | null {
  const init = args[1];
  if (!init || typeof init !== "object" || !("signal" in init)) return null;
  const signal = Reflect.get(init, "signal");
  return signal instanceof AbortSignal ? signal : null;
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClientType;

async function renderDialog(input: {
  target: MemberApiKeyTarget | null;
  onClose?: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  await act(async () => {
    root.render(createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemberApiKeyDialog, {
        target: input.target,
        onClose: input.onClose ?? (() => undefined),
        onSaved: input.onSaved,
      }),
    ));
  });
}

async function fillKey(value: string) {
  const input = document.querySelector('input[name="member-mcp-api-key"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing member API key input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function submitKey() {
  const form = document.querySelector('[data-testid="member-api-key-dialog"] form');
  if (!(form instanceof HTMLFormElement)) throw new Error("Missing member API key form");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockState.reset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  vi.restoreAllMocks();
});

test("mounted member PAT clears and closes an unsent secret across organizations", async ({ evidence }) => {
  const target = { id: "connection_a", name: "Connection A" };
  let closes = 0;
  await renderDialog({ target, onClose: () => { closes += 1; } });
  await fillKey("pat_unsent_secret");
  const unsent = document.querySelector('input[name="member-mcp-api-key"]');
  expect(unsent instanceof HTMLInputElement ? unsent.value : null).toBe("pat_unsent_secret");

  mockState.setOrganizationId("org_b");
  await renderDialog({ target, onClose: () => { closes += 1; } });
  expect(document.querySelector('[data-testid="member-api-key-dialog"]')).toBeNull();
  expect(closes).toBeGreaterThan(0);

  await renderDialog({ target });
  expect(document.querySelector('[data-testid="member-api-key-dialog"]')).toBeNull();
  await renderDialog({ target: null });
  await renderDialog({ target });
  const reselected = document.querySelector('input[name="member-mcp-api-key"]');
  expect(reselected instanceof HTMLInputElement ? reselected.value : null).toBe("");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  evidence.recordAssertionEvidence(
    "A mounted personal-key dialog binds its target lifetime to one organization",
    "Changing organizations synchronously hid the old dialog, cleared its unsent secret, and required a null-to-target reselection before reopening.",
    true,
  );
});

test("mounted member PAT delayed A cannot settle reopened B", async ({ evidence }) => {
  const requestA = deferred<{ response: Response; payload: unknown }>();
  const requestB = deferred<{ response: Response; payload: unknown }>();
  let requestCount = 0;
  mockState.setRequest(async () => requestCount++ === 0 ? requestA.promise : requestB.promise);
  let saved = 0;
  const targetA = { id: "connection_a", name: "Connection A" };
  const targetB = { id: "connection_a", name: "Connection B" };

  await renderDialog({ target: targetA, onSaved: () => { saved += 1; } });
  await fillKey("pat_request_a");
  await submitKey();
  await renderDialog({ target: null, onSaved: () => { saved += 1; } });
  await renderDialog({ target: targetB, onSaved: () => { saved += 1; } });
  await fillKey("pat_request_b");
  await submitKey();

  requestB.resolve(response(200));
  await flush();
  expect(document.body.textContent).toContain("Connection B: key saved");
  requestA.resolve(response(500));
  await flush();
  expect(document.body.textContent).toContain("Connection B: key saved");
  expect(document.body.textContent).not.toContain(MEMBER_API_KEY_UNCERTAIN_MESSAGE);
  expect(saved).toBe(1);
  evidence.recordAssertionEvidence(
    "A mounted stale request cannot set saved or error state on a reopened target",
    "B remained saved after delayed A returned 500; A produced no error, callback, or replacement state.",
    true,
  );
});

test("mounted member PAT delayed A cannot settle a different target B", async ({ evidence }) => {
  const requestA = deferred<{ response: Response; payload: unknown }>();
  const requestB = deferred<{ response: Response; payload: unknown }>();
  let requestCount = 0;
  mockState.setRequest(async () => requestCount++ === 0 ? requestA.promise : requestB.promise);
  let saved = 0;

  await renderDialog({ target: { id: "connection_a", name: "Connection A" }, onSaved: () => { saved += 1; } });
  await fillKey("pat_request_a_different_target");
  await submitKey();
  await renderDialog({ target: null, onSaved: () => { saved += 1; } });
  await renderDialog({ target: { id: "connection_b", name: "Connection B" }, onSaved: () => { saved += 1; } });
  await fillKey("pat_request_b_different_target");
  await submitKey();

  requestB.resolve(response(200));
  await flush();
  expect(document.body.textContent).toContain("Connection B: key saved");
  requestA.resolve(response(500));
  await flush();
  expect(document.body.textContent).toContain("Connection B: key saved");
  expect(document.body.textContent).not.toContain(MEMBER_API_KEY_UNCERTAIN_MESSAGE);
  expect(saved).toBe(1);
  evidence.recordAssertionEvidence(
    "A mounted stale request cannot settle a different reopened target",
    "Delayed connection A produced no saved, error, or callback state after connection B stored successfully.",
    true,
  );
});

test("mounted member PAT pending request is ignored after organization switch", async ({ evidence }) => {
  const pending = deferred<{ response: Response; payload: unknown }>();
  const oldRequest: { signal: AbortSignal | null } = { signal: null };
  mockState.setRequest((...args) => {
    oldRequest.signal = signalFromRequestArgs(args);
    return pending.promise;
  });
  let saved = 0;
  const target = { id: "connection_a", name: "Connection A" };
  await renderDialog({ target, onSaved: () => { saved += 1; } });
  await fillKey("pat_pending_org_a");
  await submitKey();

  mockState.setOrganizationId("org_b");
  await renderDialog({ target, onSaved: () => { saved += 1; } });
  expect(document.querySelector('[data-testid="member-api-key-dialog"]')).toBeNull();
  expect(oldRequest.signal?.aborted).toBe(true);
  await renderDialog({ target: null, onSaved: () => { saved += 1; } });
  await renderDialog({ target, onSaved: () => { saved += 1; } });
  const newOrganizationInput = document.querySelector('input[name="member-mcp-api-key"]');
  expect(newOrganizationInput instanceof HTMLInputElement ? newOrganizationInput.disabled : null).toBe(false);
  pending.resolve(response(200));
  await flush();
  expect(saved).toBe(0);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).not.toContain("key saved");
  evidence.recordAssertionEvidence(
    "A mounted pending personal-key request cannot cross organizations",
    "The old request was canceled and its eventual HTTP 200 was ignored without saved or error UI in the new organization.",
    true,
  );
});

test("mounted member PAT keeps HTTP 200 saved when refresh rejects", async ({ evidence }) => {
  mockState.setRequest(async () => response(200));
  vi.spyOn(queryClient, "invalidateQueries").mockRejectedValue(new Error("refresh failed"));
  await renderDialog({ target: { id: "connection_a", name: "Connection A" } });
  await fillKey("pat_stored");
  await submitKey();
  expect(document.body.textContent).toContain("Connection A: key saved");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  evidence.recordAssertionEvidence(
    "Mounted personal-key HTTP success survives refresh failure",
    "The dialog showed stored success after HTTP 200 even though query invalidation rejected.",
    true,
  );
});

test("mounted member PAT HTTP 500 reports uncertain commit", async ({ evidence }) => {
  mockState.setRequest(async () => response(500));
  await renderDialog({ target: { id: "connection_a", name: "Connection A" } });
  await fillKey("pat_uncertain");
  await submitKey();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(MEMBER_API_KEY_UNCERTAIN_MESSAGE);
  expect(document.body.textContent).not.toContain("key saved");
  evidence.recordAssertionEvidence(
    "Mounted personal-key HTTP 500 reports uncertain server commit",
    "The UI instructed the member to check status before retrying and did not claim either storage or rollback.",
    true,
  );
});

test("mounted member PAT sanitizes a rejected request containing the key", async ({ evidence }) => {
  const syntheticKey = "pat_SYNTHETIC_DO_NOT_EXPOSE_7a91";
  const errorObserver = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warnObserver = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const logObserver = vi.spyOn(console, "log").mockImplementation(() => undefined);
  mockState.setRequest(async () => { throw new Error(`provider rejected ${syntheticKey}`); });

  await renderDialog({ target: { id: "connection_a", name: "Connection A" } });
  await fillKey(syntheticKey);
  await submitKey();

  const alertText = document.querySelector('[role="alert"]')?.textContent ?? "";
  const consoleText = [errorObserver, warnObserver, logObserver]
    .flatMap((observer) => observer.mock.calls)
    .flatMap((args) => args)
    .map((value) => String(value))
    .join("\n");
  const toastText = [...document.querySelectorAll('[data-sonner-toast], [role="status"]')]
    .map((element) => element.textContent ?? "")
    .join("\n");
  expect(alertText).toBe(MEMBER_API_KEY_UNCERTAIN_MESSAGE);
  expect(alertText).not.toContain(syntheticKey);
  expect(document.body.textContent).not.toContain(syntheticKey);
  expect(toastText).not.toContain(syntheticKey);
  expect(consoleText).not.toContain(syntheticKey);
  evidence.recordAssertionEvidence(
    "A mounted rejected personal-key request does not expose the key through observed UI or console channels",
    "The real save hook received an Error containing the synthetic key; alert, DOM, toast text, console.error, console.warn, and console.log contained only sanitized output.",
    true,
  );
});

test("rejected member key opens a replacement prompt and remains stored-not-verified after save", async ({ evidence }) => {
  mockState.setRequest(async () => ({ response: new Response("{\"ok\":true}", { status: 200 }), payload: { ok: true } }));
  await renderDialog({ target: { id: "connection_rejected", name: "Private service", replacing: true } });
  expect(document.body.textContent).toContain("Replace key for Private service");
  await fillKey("synthetic-replacement-only");
  await submitKey();
  expect(document.body.textContent).toContain("Private service: key saved");
  expect(document.body.textContent).not.toContain("synthetic-replacement-only");
  expect(document.querySelector('input[name="member-mcp-api-key"]')).toBeNull();
  evidence.recordAssertionEvidence("Mounted member replacement keeps storage acknowledgement honest",
    "The replacement title, same existing masked-save flow, cleared input and saved-not-verified result passed in a mounted UI fixture. No actual product or Desktop acceptance is claimed.", true);
});
