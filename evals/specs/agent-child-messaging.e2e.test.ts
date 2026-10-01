import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { observeSessionCommands } from "../helpers/observe-session-commands.ts";
import { agentChildWeb } from "../worlds/agent-child.ts";

const test = spec.world(agentChildWeb, { timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] } });

test(`AGENT-CHILD-01 ${resolveEvalEngine()}: a person messages a busy child without stopping its grandchild and returns to its card`, async ({ world, user, probe, step, evidence }) => {
  await using commands = await observeSessionCommands(probe);
  await step("before: the main chat delegates a fixture review", async () => {
    await user.type("composer", world.prompt, { verify: true });
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the configured engine admits the first prompt", until: state => state.runTaskEnabled });
    await user.click("Run task");
    await user.see({ text: "Review fixture" }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("Delegation is visible in its original turn", "The admitted parent prompt exposes the Review fixture child in the existing live rail.", true);
    await user.screenshot();
  });
  await step("the child displays its original brief and keeps its own composer", async () => {
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await user.click({ role: "button", label: "Original task" });
    await user.see({ text: world.childPrompt });
    await user.see({ text: "Check fixture output" }, { timeoutMs: 60_000 });
    await user.screenshot();
    evidence.recordJsonArtifact("Native delegated child tools", await world.delegatedTools());
    await probe.eventually(() => world.grandchildState(), { within: 60_000, label: "grandchild holds its live reply", until: state => state.deliveredChunks === 1 });
    evidence.recordAssertionEvidence("The child exposes its original delegated brief", "Opening the child displays its brief and own composer while the grandchild holds exactly one reply chunk.", true);
    await user.screenshot();
  });
  await step("Enter admits a message to the child and issues no abort", async () => {
    await user.type("composer", world.followup, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.followup });
    const requests = await commands.read();
    evidence.recordJsonArtifact("Scoped command transport", requests);
    expect(requests.filter(request => /\/(?:abort|interrupt)$/.test(request.path))).toEqual([]);
    const state = await world.grandchildState();
    expect(state.deliveredChunks).toBe(1);
    expect(state.complete).toBe(false);
    evidence.recordAssertionEvidence("Busy-child messaging issues no abort", `The sent follow-up is visible with 0 aborts; the grandchild remains at ${state.deliveredChunks} chunk and complete=${state.complete}.`, true);
  });
  await step("Escape returns to the originating card and preserves the child's unsent draft", async () => {
    await user.type("composer", "Ask about the fixture provenance", { verify: true });
    await user.press("Escape");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" });
    expect((await probe.composer()).draftText).not.toContain("fixture provenance");
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await probe.eventually(() => probe.composer(), { within: 10_000, label: "the child restores its scoped draft", until: state => state.draftText === "Ask about the fixture provenance" });
    expect((await commands.read()).filter(request => /\/(?:abort|interrupt)$/.test(request.path))).toEqual([]);
    evidence.recordAssertionEvidence("Return navigation preserves scoped drafts", "Escape returns to the original card; the parent excludes the child draft, and reopening restores its exact text with 0 aborts.", true);
  });
  await step("after: the grandchild and child finish and the result reaches the main chat", async () => {
    await world.releaseGrandchild();
    await user.see({ text: world.finalReply }, { timeoutMs: 90_000 });
    await user.press("Escape");
    await user.see({ text: "The delegated fixture review is ready." }, { timeoutMs: 90_000 });
    await user.see("Run task");
    evidence.recordAssertionEvidence("The child result reaches the main chat", "Releasing delegated work finishes the child; returning shows the parent review result and an idle composer.", true);
    await user.screenshot();
  });
});
