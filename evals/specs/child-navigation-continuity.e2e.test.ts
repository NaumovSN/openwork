import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { agentChildWeb } from "../worlds/agent-child.ts";

const test = spec.world(agentChildWeb, { timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] } });

test(`AGENT-CHILD-NAV ${resolveEvalEngine()}: returning from a helper preserves its brief and draft`, async ({ world, user, probe, step }) => {
  await step("before: the parent shows its delegated task in the existing activity rail", async () => {
    await user.type("composer", world.prompt, { verify: true });
    await user.click("Run task");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" }, { timeoutMs: 60_000 });
    await user.screenshot();
  });
  await step("the helper keeps its original task behind a disclosure", async () => {
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await user.click({ role: "button", label: "Original task" });
    await user.see({ text: world.childPrompt });
    await user.type("composer", "Keep this helper draft", { verify: true });
    await user.press("Escape");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" });
    expect((await probe.composer()).draftText).not.toContain("helper draft");
  });
  await step("after: reopening restores the helper draft and Escape returns to the original task", async () => {
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await probe.eventually(() => probe.composer(), { within: 10_000, label: "the helper restores its own draft", until: state => state.draftText === "Keep this helper draft" });
    await user.press("Escape");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await user.screenshot();
  });
});
