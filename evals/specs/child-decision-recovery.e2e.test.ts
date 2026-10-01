import { expect, spec } from "@openwork/testkit";
import { isRecord } from "../worlds/library.ts";
import { childDecisionsWeb } from "../worlds/child-decisions.ts";

const test = spec.world(childDecisionsWeb, { timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] } });

test("a member recovers a helper's unanswered question after losing its live notification", async ({ world, user, probe, step, evidence }) => {
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${world.engine === "v2" ? "opencode2/api" : "opencode"}`;
  const pending = async () => {
    const response = await probe.desktopApi(mount + (world.engine === "v2" ? "/form/request" : "/question"));
    expect(response.status).toBe(200);
    const data = isRecord(response.body) && "data" in response.body ? response.body.data : response.body;
    if (!Array.isArray(data)) throw new Error("Native pending decisions did not return a list");
    return data.filter(isRecord).map(item => ({ id: item.id, sessionID: item.sessionID }));
  };
  await step("before: another task has its own unanswered question", async () => {
    await user.reload();
    await user.type("composer", world.unrelated.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.unrelated.question }, { timeoutMs: 60_000 });
    expect(await pending()).toEqual([expect.objectContaining({ sessionID: world.unrelated.sessionId })]);
    evidence.recordAssertionEvidence("another task owns its own decision", "The unrelated question is pending in its original conversation", true);
    await user.screenshot();
  });
  const unrelated = await pending();
  await step("the member delegates work while live question notifications are lost", async () => {
    await user.click({ text: "Delegated question parent" });
    await user.see("composer", { editable: true });
    await user.type("composer", world.root.prompt, { verify: true });
    await user.press("Enter");
    // There is no probe primitive for a fixture's transport-drop counter. This
    // observation is a witness, not a write to the app's cache or UI state.
    const dropped = await probe.eventually(() => probe.eval(() => Number(Reflect.get(window, "__childDecisionNotificationsDropped"))), {
      within: 60_000, label: "both real question notifications were dropped", until: count => count >= 2,
    });
    expect(dropped).toBeGreaterThanOrEqual(2);
    evidence.recordAssertionEvidence("live notifications really were lost", `${dropped} native question notifications were dropped; real decision endpoints remain available`, true);
  });
  await step("after: the parent recovers only its helper's question", async () => {
    await user.see({ text: world.child.question }, { timeoutMs: 30_000 });
    await user.notSee({ text: world.unrelated.question });
    const requests = await pending();
    expect(requests).toHaveLength(2);
    expect(requests).toEqual(expect.arrayContaining(unrelated));
    expect(await probe.hash()).toContain(`/session/${world.root.sessionId}`);
    evidence.recordAssertionEvidence("recover the related question without mixing tasks", "The parent displays its child's question; the unrelated question remains pending and absent from this chat", true);
    await user.screenshot();
  });
  await step("reload keeps the question answerable and answering resumes the original work", async () => {
    await user.reload();
    await user.see({ text: world.child.question }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: /^Child checklist/ });
    await user.see({ text: /User has answered your questions:.*="Child checklist"/ }, { timeoutMs: 90_000 });
    expect(await pending()).toEqual(unrelated);
    await user.notSee({ text: world.unrelated.question });
    evidence.recordAssertionEvidence("answer only the recovered helper request", "The child resumes with Child checklist; the unrelated request retains its original identity and remains unanswered", true);
    await user.screenshot();
  });
});
