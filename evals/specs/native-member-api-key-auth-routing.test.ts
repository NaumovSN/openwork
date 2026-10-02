import { test } from "@openwork/testkit";
import { expect, vi } from "vitest";

const state = vi.hoisted(() => {
  type Bootstrap = { baseUrl: string; apiBaseUrl?: string; requireSignin: boolean };
  let durable: Bootstrap = { baseUrl: "https://web.example.test", requireSignin: false };
  let effective: Bootstrap = { ...durable, apiBaseUrl: "https://api.example.test" };
  let token = "old-session";
  let mismatch = false;
  let persistFailure = false;
  let hold: (() => Promise<void>) | null = null;
  let writes = 0;
  let activations = 0;
  return {
    reset() { durable = { baseUrl: "https://web.example.test", requireSignin: false }; effective = { ...durable, apiBaseUrl: "https://api.example.test" }; token = "old-session"; mismatch = false; persistFailure = false; hold = null; writes = 0; activations = 0; },
    durable: () => ({ ...durable }), effective: () => ({ ...effective }), token: () => token,
    counts: () => ({ writes, activations }), mismatch: () => { mismatch = true; }, fail: () => { persistFailure = true; },
    hold: (next: () => Promise<void>) => { hold = next; },
    async persist(next: Bootstrap) {
      writes++;
      durable = { ...next, ...(mismatch ? { apiBaseUrl: "https://wrong.example.test" } : {}) };
      effective = { ...next };
      if (hold) { const pending = hold; hold = null; await pending(); }
      if (persistFailure) throw Error("Synthetic write failure");
    },
    async restore(next: Bootstrap) { durable = { ...next }; },
    async refresh() { effective = { ...durable, apiBaseUrl: durable.apiBaseUrl ?? "https://api.example.test" }; },
    activate(next: { authToken: string }) { token = next.authToken; activations++; },
  };
});

vi.mock("../../apps/app/src/app/lib/den", () => ({
  createDenClient: () => ({ exchangeDesktopHandoff: async (grant: string) => ({ token: `session-${grant}`, user: { id: "user_a" }, organization: { id: "org_a" }, connectEnabled: false }) }),
  denOriginComparisonKey: (value: string) => new URL(value).origin,
  readDenBootstrapConfig: state.effective,
  readDenSettings: () => ({ ...state.effective(), authToken: state.token(), activeOrgId: "org_a" }),
  resolveDenBaseUrlsForDestination: async (input: { baseUrl: string; apiBaseUrl?: string }) => ({ baseUrl: input.baseUrl, apiBaseUrl: input.apiBaseUrl ?? "https://api.example.test" }),
  setDenBootstrapConfig: state.persist,
  initializeDenBootstrapConfig: state.refresh,
  writeDenSettings: state.activate,
  seedDenDesktopConfigConnectPolicy: () => undefined,
}));
vi.mock("../../apps/app/src/app/lib/desktop", () => ({ getDesktopBootstrapConfig: async () => state.durable(), setDesktopBootstrapConfig: state.restore }));
vi.mock("../../apps/app/src/app/lib/runtime-env", () => ({ isDesktopRuntime: () => true }));
vi.mock("../../apps/app/src/app/lib/den-session-events", () => ({ dispatchDenSessionUpdated: () => undefined }));
vi.mock("../../apps/app/src/app/lib/den-sign-in-intent", () => ({
  clearDesktopSignInIntent: () => undefined, clearOrgSelectionPending: () => undefined,
  hasActiveDesktopSignInIntent: () => false, markOrgSelectionPending: () => undefined,
  resolveHandoffOrgPlan: () => ({ kind: "activate", organization: { id: "org_a" } }),
}));
const { exchangeHandoffAndSignIn } = await import("../../apps/app/src/app/lib/den-handoff.ts");

test("native sign-in persists explicit API and restores actual durable routing on failed or superseded commit", async ({ evidence }) => {
  const options = { baseUrl: "https://web.example.test", apiBaseUrl: "https://new-api.example.test", desktopInitiated: false };
  state.reset();
  expect((await exchangeHandoffAndSignIn("first", options)).ok).toBe(true);
  expect(state.durable().apiBaseUrl).toBe(options.apiBaseUrl);
  expect(state.token()).toBe("session-first");

  for (const failure of ["readback", "write"]) {
    state.reset();
    const before = state.durable();
    expect(before.apiBaseUrl).toBeUndefined();
    expect(state.effective().apiBaseUrl).toBe("https://api.example.test");
    if (failure === "readback") state.mismatch(); else state.fail();
    expect((await exchangeHandoffAndSignIn(failure, options)).ok).toBe(false);
    expect(state.durable()).toEqual(before);
    expect(state.token()).toBe("old-session");
    expect(state.counts().activations).toBe(0);
  }

  state.reset();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.hold(async () => { entered(); await gate; });
  const old = exchangeHandoffAndSignIn("old", options);
  await arrived;
  const newestOptions = { ...options, apiBaseUrl: "https://newest-api.example.test" };
  const latest = exchangeHandoffAndSignIn("newest", newestOptions);
  release();
  expect((await old).ok).toBe(false);
  expect((await latest).ok).toBe(true);
  expect(state.durable().apiBaseUrl).toBe(newestOptions.apiBaseUrl);
  expect(state.token()).toBe("session-newest");

  state.reset();
  expect((await exchangeHandoffAndSignIn("default", { baseUrl: options.baseUrl, desktopInitiated: false })).ok).toBe(true);
  expect(state.durable().apiBaseUrl).toBeUndefined();
  expect(state.counts().writes).toBe(0);
  evidence.recordAssertionEvidence("Durable API sign-in transaction", "Explicit API commits; differing native readback/write failure restore actual prior omitted API and retain session; superseded attempt never activates; omitted API retains existing default behavior", true);
});
