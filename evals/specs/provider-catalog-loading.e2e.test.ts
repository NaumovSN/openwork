import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { providerCatalogLoading } from "../worlds/provider-catalog-loading.ts";

const test = spec.world(providerCatalogLoading, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("a member reopens a loaded model picker without fetching the catalog again and can still send a task", async ({ world, user, probe, step, evidence }) => {
  const option = { testId: `model-option-${world.providerId}-${world.modelId}` };
  const picker = '[data-testid="composer-model-picker"]';
  const settled = () => probe.eventually(async () => world.catalogReads(), {
    within: 15_000, label: "catalog reads have finished", until: (reads) => reads.pending === 0 && reads.quietMs >= 500,
  });
  const closePicker = async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.dom(picker), {
      within: 5_000, label: "the picker closes", until: (dom) => dom.elements.length === 0,
    });
  };

  await step("before: the member has loaded their models and keeps a draft in the composer", async () => {
    await user.type("composer", world.prompt);
    await user.click({ role: "button", label: "Change model" });
    await user.see(option, { text: /Reasoning witness/ });
    await user.see({ testId: "model-option-effort-witness-standard" }, { text: /Standard witness/ });
    const reads = await settled();
    const rows = (await probe.dom(`${picker} [data-model-key]`)).elements.length;
    evidence.recordAssertionEvidence("The catalog is loaded", `${rows} model rows are visible; ${reads.pending} catalog reads remain in flight`, rows >= 2 && reads.pending === 0);
    expect(rows).toBeGreaterThanOrEqual(2);
    await user.screenshot();
    await closePicker();
  });

  await step("after: reopening the picker twice uses the loaded names with zero extra catalog requests", async () => {
    const before = (await settled()).count;
    for (let open = 0; open < 2; open += 1) {
      await user.click({ role: "button", label: "Change model" });
      await user.see(option, { text: /Reasoning witness/ });
      await user.see("composer", { text: world.prompt });
      await settled();
      await user.screenshot();
      await closePicker();
    }
    const reads = await settled();
    const extra = reads.count - before;
    evidence.recordAssertionEvidence("Warm picker opens need no network reads", `2 opens; ${extra} additional model, default, or provider-name requests; draft preserved`, extra === 0);
    expect(extra).toBe(0);
  });

  await step("the cached choice still sends the member's task through the native engine", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click(option);
    await user.click("Run task");
    await user.see({ text: "Air scatters blue light more strongly." }, { timeoutMs: 90_000 });
    const requests = await world.requests();
    evidence.recordAssertionEvidence("The selected model remains usable", `${requests.length} inference request; model ${requests[0]?.model ?? "missing"}; native engine ${world.engine}`, requests.length === 1 && requests[0]?.model === world.modelId);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(world.modelId);
    await user.screenshot();
  });
});
