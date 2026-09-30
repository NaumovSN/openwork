import { expect } from "vitest";
import { observeActivity, observeSessionCommands, resolveEvalEngine, spec } from "@openwork/testkit";
import { wholeActivity } from "../worlds/whole-activity.ts";

const test = spec.world(wholeActivity, { timeout: 600_000, resources: { surfaces: ["desktop"], services: ["den", "mock"],
  nativeReason: "One native Desktop conversation exercises composer keys, child navigation, connected results and the tray above the editor." } });

test(`ACT-WHOLE ${resolveEvalEngine()}: a person follows a whole conversation from a short reply through tools, decisions, children and Stop`, async ({ world, user, probe, step, evidence }) => {
  let firstSend = true;
  const send = async (text: string) => {
    if (firstSend) {
      evidence.recordJsonArtifact("Initial native input focus", await world.inputFocus());
      await user.screenshot();
      firstSend = false;
    }
    try { await user.type("composer", text, { verify: true }); }
    catch (error) {
      evidence.recordJsonArtifact("Fixture composer after typing", await probe.composer());
      evidence.recordJsonArtifact("Native focus after typing", await world.inputFocus());
      await user.screenshot();
      throw error;
    }
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the composer admits this turn", until: state => state.runTaskEnabled });
    await user.press("Enter");
  };
  await step("before: even a short answer has a finished activity summary", async () => {
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the new fixture chat and its model have loaded",
      until: state => state.route.includes(world.session.sessionId) && state.composerEditable && state.selectedModelLabel.includes("First fixture model"),
    });
    await send(world.shortPrompt);
    await user.see({ text: "Version three." });
    await user.see({ role: "button", label: /Worked for.*0 steps.*Show steps/ });
    evidence.recordAssertionEvidence("Short replies receive a finished summary", "The short answer is visible beside a finished activity summary with 0 steps.", true);
    await user.screenshot();
  });
  await step("one steady run reads, runs a command and uses a connected service before delegating", async () => {
    await send(world.prompt);
    await user.click({ role: "button", label: /Earlier steps.*Show steps/ });
    await using activity = await observeActivity(probe);
    await user.see({ text: "Confirm fixture format" }, { timeoutMs: 90_000 });
    const delegation = await probe.eventually(async () => ({ failures: (await world.nativeTools()).filter(tool => tool.state?.status === "error"), needs: (await probe.dom("[data-agent-tray]")).elements.some(element => element.text.includes("needs you")) }), {
      within: 60_000, label: "the native child reaches its decision", until: state => state.needs || state.failures.length > 0,
    }).catch(async error => {
      const tools = await world.nativeTools();
      evidence.recordJsonArtifact("Native tools before the missing child decision", tools);
      for (const tool of tools) {
        const metadata = tool.state?.metadata;
        if (tool.tool !== "task" || !metadata || typeof metadata !== "object" || !("sessionId" in metadata) || typeof metadata.sessionId !== "string") continue;
        evidence.recordJsonArtifact("Native child tools before the missing decision", await world.nativeTools(metadata.sessionId));
      }
      evidence.recordJsonArtifact("Child rows before the missing decision", await probe.dom("[data-subagent-run], [data-agent-tray]"));
      evidence.recordJsonArtifact("Composer before the missing decision", await probe.composer());
      await user.screenshot();
      throw error;
    });
    evidence.recordJsonArtifact("Native fixture delegation", delegation);
    expect(delegation.failures).toEqual([]);
    await user.see({ role: "button", label: /1 needs you/ }, { timeoutMs: 60_000 });
    const before = (await probe.dom("[data-working-line]")).elements.map(element => element.text);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const after = (await probe.dom("[data-working-line]")).elements.map(element => element.text);
    expect(after).toEqual(before);
    expect(before.join(" ")).toMatch(/Waiting for your action/);
    const tray = await probe.dom("[data-agent-tray], [contenteditable='true']");
    expect(tray.elements[0]!.rect.bottom).toBeLessThanOrEqual(tray.elements[1]!.rect.top);
    evidence.recordJsonArtifact("Tray placement and paused decision time", { tray, before, after });
    const trace = (await activity.finish()).filter(sample => sample.liveHeight !== null);
    evidence.recordJsonArtifact("Native activity continuity sampled every 50 ms", trace);
    expect(trace.length).toBeGreaterThan(20);
    expect(trace.every(sample => sample.railExpanded), "the startup disclosure stays visibly open after the first reply arrives").toBe(true);
    expect(Math.max(...trace.map(sample => sample.visibleRows.length)), "multiple native steps are visible in the opened rail").toBeGreaterThanOrEqual(2);
    expect(Math.max(...trace.map(sample => sample.railHeight ?? 0)), "the proof observes tool rows, not just the compact shell").toBeGreaterThan(48);
    expect(trace.flatMap(sample => sample.replacements), "native step rows stay mounted during streaming").toEqual([]);
    expect(trace.slice(1).filter((sample, index) => sample.liveHeight! < trace[index]!.liveHeight! - 1), "automatic updates do not shrink the opened rail").toEqual([]);
    evidence.recordAssertionEvidence("Expanded activity remains steady through native tools and a child decision", `${trace.length} samples remain expanded with ${Math.max(...trace.map(sample => sample.visibleRows.length))} visible rows, 0 replacements and 0 height drops; the needs-you tray stays above the editor and waiting time pauses.`, true);
    await user.screenshot();
  });
  await step("the tray opens the correct child decision, and the child can receive a message while working", async () => {
    await user.click({ role: "button", label: "1 needs you" });
    await user.click({ role: "button", label: "Answer" });
    await user.see({ text: "Task from the main chat" });
    await user.see({ text: world.childPrompt });
    await user.see({ text: "Which fixture format should I use?" });
    await user.click({ role: "button", label: /^Fixture checklist/ });
    await probe.eventually(() => world.childState(), { within: 30_000, label: "the answered child resumes work", until: state => state.deliveredChunks === 1 });
    await using commands = await observeSessionCommands(probe);
    await user.type("composer", world.followup, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.followup });
    expect((await commands.read()).filter(request => /\/(?:abort|interrupt)$/.test(request.path))).toEqual([]);
    await user.type("composer", "/", { replace: true, verify: true });
    await probe.eventually(() => probe.dom('[data-composer-menu-open="true"]'), {
      within: 5_000, label: "the child's command menu opens", until: value => value.elements.length === 1,
    });
    await user.press("Escape");
    await user.see({ text: "Task from the main chat" });
    expect((await probe.dom('[data-composer-menu-open="true"]')).elements).toHaveLength(0);
    await user.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await user.press("Backspace");
    expect((await probe.composer()).draftText).toBe("");
    await user.click({ role: "button", label: "Change model" });
    await probe.eventually(() => probe.dom('[data-testid="composer-model-picker"]'), {
      within: 5_000, label: "the child's model picker is visibly open",
      until: value => value.elements.some(element => element.rect.width > 0 && element.rect.height > 0),
    });
    await user.press("Escape");
    await user.see({ text: "Task from the main chat" });
    await probe.eventually(() => probe.dom('[data-testid="composer-model-picker"]'), {
      within: 5_000, label: "Escape closes the model menu before returning", until: value => value.elements.every(element => element.rect.width === 0 || element.rect.height === 0),
    });
    await world.finishChild();
    await user.press("Escape");
    await user.see({ text: world.answer }, { timeoutMs: 90_000 });
    await user.see("Run task");
    evidence.recordAssertionEvidence("The correct child accepts a busy follow-up without interruption", "Answer opens the child's original brief and decision; the follow-up is visible with 0 aborts, Escape closes command and model menus first, and the next Escape returns to the parent answer.", true);
  });
  await step("finished tools fold while the answer and exact service result stay accessible", async () => {
    await user.click({ role: "button", label: /Worked for.*[1-9] steps.*Show steps/ });
    if (world.engine === "v2") await user.click({ role: "button", label: /Looked up.*Show steps/ });
    const results = await probe.dom("[data-tool-result-preview]");
    evidence.recordJsonArtifact("Recorded tool results", { native: await world.nativeTools(), rendered: results });
    expect(results.elements.some(element => element.text.includes(world.proof))).toBe(true);
    await user.see({ text: world.answer });
    evidence.recordAssertionEvidence("Readable service results stay associated with their step", `A recorded tool preview contains the exact fixture result ${world.proof}; the final answer remains visible after reopening the finished turn.`, true);
    await user.screenshot();
  });
  await step("a model switch keeps historical model identity, and Stop leaves an ordinary composer", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.type({ placeholder: "Search models..." }, "Second fixture model");
    await user.click({ role: "option", label: /^Second fixture model/ });
    await user.press("Escape");
    await send(world.stopPrompt);
    await probe.eventually(() => world.nativeTools(), { within: 30_000, label: "the long command is actively running before Stop",
      until: tools => tools.some(tool => (tool.tool === "shell" || tool.tool === "bash") && tool.state?.status === "running"),
    });
    await user.click({ role: "button", label: "Stop" });
    await user.see("Run task");
    await user.see({ role: "button", label: /Stopped after.*Show steps/ });
    await user.notSee({ role: "button", label: /^(Continue|Resume)$/ });
    await send(world.continuePrompt);
    await user.see({ text: "The fixture version is 3." });
    const summaries = (await probe.dom("[data-steady-activity] > div > button")).elements.map(element => element.text);
    expect(summaries.some(text => text.includes("First fixture model"))).toBe(true);
    expect(summaries.some(text => text.includes("Second fixture model"))).toBe(true);
    evidence.recordAssertionEvidence("Stop leaves an ordinary composer and preserves model history", "Acknowledged Stop shows a stopped summary and 0 Continue/Resume controls; manually sending the continuation produces the answer, while both historical model names remain visible.", true);
  });
  if (world.engine === "v2") await step("native background completion resumes the idle parent and Stop all reaches an active background child", async () => {
    await send(world.backgroundPrompt);
    await user.see({ text: "The fixture helper is checking in the background." });
    await probe.eventually(() => world.backgroundState(), { within: 30_000, label: "background work continues after the parent finishes", until: state => state.deliveredChunks === 1 });
    await user.see("Run task");
    await world.finishBackground();
    await user.see({ text: world.backgroundWake }, { timeoutMs: 60_000 });
    expect((await probe.dom("[data-session-notice]")).elements.length).toBeGreaterThan(0);
    await send(world.backgroundStopPrompt);
    await user.see({ text: "Another fixture helper is checking in the background." });
    await probe.eventually(() => world.stoppedBackgroundState(), { within: 30_000, label: "another background child holds its own reply", until: state => state.deliveredChunks === 1 });
    await user.click({ role: "button", label: "Stop all" });
    await probe.eventually(() => world.stoppedBackgroundState(), { within: 30_000, label: "Stop all is acknowledged by the active background child", until: state => state.aborted });
    evidence.recordAssertionEvidence("Native v2 background completion and Stop all are observable", "The idle parent resumes from a linked native completion notice; a later active background child's Stop all is acknowledged by its provider.", true);
  });
  await step("after: reload preserves readable results, finished turns and the final answer", async () => {
    await user.reload();
    await user.see({ text: "The fixture version is 3." }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", label: /^(Continue|Resume)$/ });
    evidence.recordAssertionEvidence("Reload preserves the completed conversation", "The final manually continued answer survives reload with 0 Continue/Resume controls.", true);
    await user.screenshot();
  });
});
