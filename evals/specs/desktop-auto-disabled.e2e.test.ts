import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelPickerDisabledAuto } from "../worlds/chat.ts";

const test = spec.world(modelPickerDisabledAuto, {
  timeout: 420_000,
  resources: {
    surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The Auto status query and initial model choice run only in Electron against the native local relay.",
  },
});

test("a member with a saved Auto default can choose a working model while free access is switched off", async ({ world, user, probe, step }) => {
  const option = (model: { providerID: string; modelID: string }) => ({ testId: `model-option-${model.providerID}-${model.modelID}` });
  const draft = "Keep this draft while free access is switched off.";
  const quiet = async () => {
    await user.notSee(option(world.auto));
    await user.notSee({ testId: "auto-picker-recovery" });
    await user.notSee({ testId: "auto-first-use" });
    await user.notSee({ text: "Auto status unavailable" });
    await user.notSee({ text: "Temporarily unavailable" });
    await user.notSee({ text: "Saved selection" });
  };
  await step("before: the member opens a new task with free access switched off and an Auto preference saved", async () => {
    const status = await probe.api(world.den.admin, "/v1/inference/access");
    expect(status.response.status).toBe(200);
    expect(status.body).toMatchObject({ access: { reason: "free_disabled" } });
    expect(await probe.storage("openwork.defaultModel")).toBe(`${world.auto.providerID}/${world.auto.modelID}`);
    await user.see("composer", { editable: true });
    expect((await probe.dom('button[aria-label="Change model"]')).elements.map((element) => element.text)).not.toContain("Auto");
    await user.see({ role: "button", label: "Change model" }, { text: "Organization witness" });
    await user.type("composer", draft, { verify: true });
    expect((await probe.composer()).draftText).toBe(draft);
    await quiet();
    await user.screenshot();
  });
  await step("after: the picker quietly offers BYOK and organization models without an Auto recovery wall", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.see(option(world.byok));
    await user.see(option(world.organization));
    await quiet();
    expect((await probe.composer()).draftText).toBe(draft);
    await user.screenshot();
  });
  await step("choosing BYOK preserves the draft and leaves free access switched off", async () => {
    await user.click(option(world.byok));
    await user.see({ role: "button", label: "Change model" }, { text: "BYOK witness" });
    await user.see("composer", { text: draft });
    await quiet();
    expect((await probe.api(world.den.admin, "/v1/inference/access")).body).toMatchObject({ access: { reason: "free_disabled" } });
    await user.screenshot();
  });
});
