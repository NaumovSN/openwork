import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InferenceAccess } from "@openwork/types/den/inference";
import { OpenWorkModelsProviderCard } from "../app/(den)/dashboard/_components/inference-providers-screen";
import { OpenWorkModelAllowance } from "../app/(den)/dashboard/_components/inference-provider-detail-screen";
import { readOpenWorkModelAccess } from "../app/(den)/dashboard/_components/inference-provider-request";

const components = join(import.meta.dir, "..", "app", "(den)", "dashboard", "_components");
const screen = readFileSync(join(components, "inference-screen.tsx"), "utf8");
const detail = readFileSync(join(components, "inference-provider-detail-screen.tsx"), "utf8");
const list = readFileSync(join(components, "inference-providers-screen.tsx"), "utf8");
const navigation = readFileSync(join(components, "..", "_lib", "dashboard-navigation.ts"), "utf8");
const access: InferenceAccess = {
  kind: "free", modelID: "fixture-auto", weeklyLimitUsd: 2, usedUsd: 0.5, reservedUsd: 0.25,
  remainingUsd: 1.25, resetsAt: "2026-09-21T00:00:00.000Z", reason: null, canUpgrade: false,
  catalog: [{ modelID: "fixture-auto", displayName: "Auto", providerName: "OpenWork", summary: "Free model", recommended: true, rank: 1, capabilities: ["tools"] }],
};

function card(value: InferenceAccess | null, error: string | null = null, busy = false) {
  return renderToStaticMarkup(createElement(OpenWorkModelsProviderCard, { orgSlug: "example", access: value, busy, error }));
}

describe("OpenWork Models provider", () => {
  test("renders one standard provider card from access status, not member provider rows", () => {
    const html = card(access);
    expect(html).toContain("OpenWork Models");
    expect(html).toContain("Included");
    expect(html).toContain("Auto");
    expect(html).toContain('href="/dashboard/gateway-providers/openwork"');
    expect(html).toContain("openwork-mark.svg");
    expect(html).not.toContain("Subscribe");
    expect(html).not.toContain("Ready");
    expect(list.match(/<OpenWorkModelsProviderCard /g)).toHaveLength(1);
    expect(list).not.toContain("useOrgLlmProviders");
  });

  test("does not turn unavailable, exhausted, stale or missing access into readiness", () => {
    expect(card(null)).toContain("Could not verify");
    expect(card(null, null, true)).toContain("Checking access");
    expect(card(access, "Network failure")).toContain("Could not verify");
    expect(card({ ...access, kind: "exhausted", reason: "free_allowance_exhausted" })).toContain("Allowance exhausted");
    expect(card({ ...access, kind: "unavailable", reason: "admin_disabled" })).toContain("Disabled by organization");
    expect(card({ ...access, kind: "unavailable", reason: "upstream_unavailable" })).toContain("Unavailable");
    expect(card({ ...access, catalog: undefined })).toContain("Model catalog not reported");
  });

  test("parses the backend access contract without synthesizing a catalog or entitlement", () => {
    expect(readOpenWorkModelAccess({ access })).toEqual(access);
    expect(readOpenWorkModelAccess({ inference: { subscribed: true } })).toBeNull();
    expect(readOpenWorkModelAccess({ access: { kind: "free" } })).toBeNull();
    expect(readOpenWorkModelAccess({ access: { ...access, remainingUsd: -1 } })).toBeNull();
    expect(readOpenWorkModelAccess({ access: { ...access, catalog: undefined } })?.catalog).toBeUndefined();
  });

  test("uses the existing detail and table with only backend-supplied models", () => {
    expect(detail).toContain('inferenceProviderId === "openwork"');
    expect(detail).toContain('<DenTable headerTone="plain" columns={columns} rows={access?.catalog ?? []}');
    expect(detail).toContain("Model catalog unavailable from this server.");
    expect(detail).not.toContain("INFERENCE_MODEL_ALIASES");
    expect(screen).not.toContain("INFERENCE_MODEL_ALIASES");
    expect(screen).not.toContain("/v1/billing/stripe/checkout");
    expect(screen).not.toContain("Subscribe");
  });

  test("keeps the inference deep link as Usage & billing and displays real allowance values", () => {
    expect(navigation).toContain('href: getInferenceRoute(orgSlug), label: "Usage & billing"');
    expect(screen).toContain('<DenPageHeader title="Usage & billing"');
    expect(screen).toContain("getBillingRoute");
    const html = renderToStaticMarkup(createElement(OpenWorkModelAllowance, { access }));
    expect(html).toContain("$2.00");
    expect(html).toContain("$0.50");
    expect(html).toContain("$1.25");
    expect(renderToStaticMarkup(createElement(OpenWorkModelAllowance, { access: null }))).toContain("Allowance unavailable");
  });
});
