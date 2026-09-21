import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FreeInferenceProviderSummary } from "@openwork/types/den/inference";
import { OpenWorkModelsProviderCard } from "../app/(den)/dashboard/_components/inference-providers-screen";
import { OpenWorkModelAllowance, OpenWorkFreeProviderContent } from "../app/(den)/dashboard/_components/inference-provider-detail-screen";
import { readFreeInferenceProvider, readOpenWorkModelAccess } from "../app/(den)/dashboard/_components/inference-provider-request";
import { saveOpenWorkAutoPin, useOpenWorkFreeProvider } from "../app/(den)/dashboard/_components/inference-provider-data";
import * as requests from "../app/(den)/_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../app/(den)/_lib/org-scope";

const components = join(import.meta.dir, "..", "app", "(den)", "dashboard", "_components");
const screen = readFileSync(join(components, "inference-screen.tsx"), "utf8");
const detail = readFileSync(join(components, "inference-provider-detail-screen.tsx"), "utf8");
const list = readFileSync(join(components, "inference-providers-screen.tsx"), "utf8");
const navigation = readFileSync(join(components, "..", "_lib", "dashboard-navigation.ts"), "utf8");
const provider: FreeInferenceProviderSummary = {
  state: "available", reason: null, defaultPinned: true, modelGroup: { id: "free", name: "Free" },
  catalog: [{ modelID: "fixture-auto", displayName: "Auto", providerName: "OpenWork", summary: "Free model", recommended: true, rank: 1, capabilities: ["tools"] }],
  allowance: { usageScope: "organization", allowanceScope: "person", windowStartAt: "2026-09-14T00:00:00.000Z", resetsAt: "2026-09-21T00:00:00.000Z",
    weeklyLimitUsd: 5, joinedMembers: 23, eligibleMembers: 23, exhaustedMembers: 4, usedUsd: 12.5, reservedUsd: 0.25, retainedUsd: 1, requestCount: 60 },
};
function card(value: FreeInferenceProviderSummary | null, error: string | null = null, busy = false) {
  return renderToStaticMarkup(createElement(OpenWorkModelsProviderCard, { orgSlug: "example", provider: value, busy, error }));
}

describe("OpenWork Models provider", () => {
  test("shows one standard card with actual org metrics and pin policy", () => {
    const html = card(provider);
    for (const value of ["OpenWork Models", "Included", "Free plan", "1 model group", "Auto pinned", "4 of 23", "$12.50", "openwork-mark.svg"]) expect(html).toContain(value);
    expect(html).toContain('href="/dashboard/gateway-providers/openwork"');
    expect(html).not.toContain("Subscribe");
    expect(html).not.toContain("Ready");
    expect(card({ ...provider, defaultPinned: false })).toContain("Auto not pinned");
    expect(list.match(/<OpenWorkModelsProviderCard /g)).toHaveLength(1);
    expect(list).not.toContain("useOrgLlmProviders");
    expect(list).not.toContain("useOpenWorkModelAccess");
  });

  test("does not invent readiness or zero counts from unavailable, stale or missing data", () => {
    expect(card(null)).toContain("Could not verify");
    expect(card(null, null, true)).toContain("Checking access");
    expect(card(provider, "Network failure")).toContain("Could not verify");
    expect(card({ ...provider, state: "disabled", reason: "admin_disabled" })).toContain("Disabled by organization");
    const unavailable = { ...provider, state: "unavailable", reason: "accounting_unavailable", allowance: { ...provider.allowance, usedUsd: null, exhaustedMembers: null } } satisfies FreeInferenceProviderSummary;
    expect(card(unavailable)).toContain("Allowance unavailable");
    expect(card(unavailable)).toContain("Not reported");
    expect(card(unavailable)).not.toContain("$0.00");
  });

  test("parses org metrics only from the admin contract, never from a person's allowance", () => {
    expect(readFreeInferenceProvider({ provider })).toEqual(provider);
    expect(readFreeInferenceProvider({ access: { kind: "free", usedUsd: 3 } })).toBeNull();
    expect(readFreeInferenceProvider({ provider: { ...provider, allowance: { ...provider.allowance, usageScope: "person" } } })).toBeNull();
    expect(readFreeInferenceProvider({ provider: { ...provider, defaultPinned: undefined } })).toBeNull();
    const access = { kind: "free", modelID: "fixture-auto", weeklyLimitUsd: 5, usedUsd: 0, reservedUsd: 0, remainingUsd: 5, resetsAt: null, reason: null, defaultPinned: false };
    expect(readOpenWorkModelAccess({ access })?.defaultPinned).toBe(false);
  });

  test("pin writes send only the scoped boolean and preserve the server response", async () => {
    const request = spyOn(requests, "requestJson").mockResolvedValue({ response: Response.json({ defaultPinned: false }), payload: { defaultPinned: false }, text: '{"defaultPinned":false}' });
    try {
      expect(await saveOpenWorkAutoPin("org-current", false)).toBe(false);
      expect(request).toHaveBeenCalledWith("/v1/inference/free/pins", { method: "PATCH", headers: { [ORG_SCOPE_HEADER]: "org-current" }, body: '{"defaultPinned":false}' }, 15000);
    } finally { request.mockRestore(); }
  });

  test("organization changes and revoked admin access cannot retain or restore another org's metrics", async () => {
    GlobalRegistrator.register();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    type Result = Awaited<ReturnType<typeof requests.requestJson>>;
    let resolveA: (result: Result) => void = () => {};
    let resolveB: (result: Result) => void = () => {};
    const pendingA = new Promise<Result>((resolve) => { resolveA = resolve; });
    const pendingB = new Promise<Result>((resolve) => { resolveB = resolve; });
    const result = (value: FreeInferenceProviderSummary): Result => ({ response: Response.json({ provider: value }), payload: { provider: value }, text: JSON.stringify({ provider: value }) });
    let calls = 0;
    const request = spyOn(requests, "requestJson").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return result(provider);
      if (calls === 2) return pendingA;
      if (calls === 3) return pendingB;
      return { response: Response.json({ error: "forbidden" }, { status: 403 }), payload: { error: "forbidden" }, text: '{"error":"forbidden"}' };
    });
    let reload: () => Promise<void> = async () => {};
    function Harness({ orgId }: { orgId: string }) {
      const state = useOpenWorkFreeProvider(orgId);
      reload = state.reload;
      return createElement("output", null, state.provider ? String(state.provider.allowance.joinedMembers) : "none");
    }
    try {
      await act(async () => root.render(createElement(Harness, { orgId: "org-a" })));
      expect(container.textContent).toBe("23");
      let oldReload: Promise<void> | undefined;
      await act(async () => { oldReload = reload(); });
      await act(async () => root.render(createElement(Harness, { orgId: "org-b" })));
      expect(container.textContent).toBe("none");
      await act(async () => resolveB(result({ ...provider, allowance: { ...provider.allowance, joinedMembers: 7, eligibleMembers: 7 } })));
      expect(container.textContent).toBe("7");
      await act(async () => { resolveA(result(provider)); await oldReload; });
      expect(container.textContent).toBe("7");
      await act(async () => { await reload(); });
      expect(container.textContent).toBe("none");
    } finally { await act(async () => root.unmount()); request.mockRestore(); container.remove(); await GlobalRegistrator.unregister(); }
  });

  test("Free group expands and Auto unpin is admin-only without removing the available model", async () => {
    GlobalRegistrator.register();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const writes: boolean[] = [];
    function Harness({ canManage }: { canManage: boolean }) {
      const [current, setCurrent] = useState(provider);
      return createElement(OpenWorkFreeProviderContent, { provider: current, canManage, onSetDefaultPinned: async (defaultPinned) => { writes.push(defaultPinned); setCurrent({ ...current, defaultPinned }); } });
    }
    try {
      await act(async () => root.render(createElement(Harness, { canManage: false })));
      const unpin = () => container.querySelector<HTMLButtonElement>('[aria-label="Unpin Auto"]');
      expect(unpin()?.disabled).toBe(true);
      expect(container.textContent).not.toContain("4 of 23");
      expect(container.textContent).not.toContain("$12.50");
      await act(async () => unpin()?.click());
      expect(writes).toEqual([]);
      await act(async () => root.render(createElement(Harness, { canManage: true })));
      const group = container.querySelector<HTMLDetailsElement>('[data-testid="free-model-group"]');
      expect(group?.open).toBe(false);
      await act(async () => group?.querySelector("summary")?.click());
      expect(group?.open).toBe(true);
      expect(group?.textContent).toContain("fixture-auto");
      await act(async () => unpin()?.click());
      expect(writes).toEqual([false]);
      expect(container.textContent).toContain("Auto is not pinned for members.");
      expect(group?.textContent).toContain("1 model · 0 pinned");
      expect(group?.textContent).toContain("fixture-auto");
      expect(group?.open).toBe(true);
      const pin = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Pin Auto");
      await act(async () => pin?.click());
      expect(writes).toEqual([false, true]);
      expect(unpin()?.disabled).toBe(false);
    } finally { await act(async () => root.unmount()); container.remove(); await GlobalRegistrator.unregister(); }
  });

  test("uses a shared detail header and preserves Usage & billing deep links without paid offers", () => {
    expect(detail).toContain('inferenceProviderId === "openwork"');
    expect(detail.match(/<ProviderDetailHeader /g)).toHaveLength(2);
    expect(detail).not.toContain("INFERENCE_MODEL_ALIASES");
    expect(screen).not.toContain("INFERENCE_MODEL_ALIASES");
    expect(screen).not.toContain("/v1/billing/stripe/checkout");
    expect(screen).not.toContain("Subscribe");
    expect(navigation).toContain('href: getInferenceRoute(orgSlug), label: "Usage & billing"');
    expect(screen).toContain('<DenPageHeader title="Usage & billing"');
    expect(screen).toContain("Organization Free allowance");
    expect(screen).not.toContain("useOpenWorkModelAccess");
    const html = renderToStaticMarkup(createElement(OpenWorkModelAllowance, { provider }));
    for (const value of ["$5.00", "4 of 23", "$12.50", "paid usage is separate"]) expect(html).toContain(value);
  });
});
