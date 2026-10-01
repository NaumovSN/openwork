import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { notificationCenter } from "../worlds/notification-center.ts";

// Keep the existing Electron archive/undo regression; member-activity-sync uses
// appWeb for the new member inventory story without a native dependency.
const test = spec.world(notificationCenter, {
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Preserves the existing desktop archive confirmation and background-event integration regression." },
});

const bell: Target = { role: "button", label: /^Activity/ };
const emptyTitle: Target = { text: "Nothing new" };
const undoButton: Target = { role: "button", label: "Undo" };

type ListedNotification = { kind: string; title: string; readAt: number | null; count: number; actionType: string | null };

function listed(value: unknown): ListedNotification[] {
  if (!Array.isArray(value)) throw new Error(`notifications.list did not return a list: ${JSON.stringify(value)}`);
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Malformed notification entry");
    const kind: unknown = Reflect.get(entry, "kind");
    const title: unknown = Reflect.get(entry, "title");
    const readAt: unknown = Reflect.get(entry, "readAt");
    const count: unknown = Reflect.get(entry, "count");
    const actionType: unknown = Reflect.get(entry, "actionType");
    if (typeof kind !== "string" || typeof title !== "string" || typeof count !== "number"
      || (readAt !== null && typeof readAt !== "number") || (actionType !== null && typeof actionType !== "string")) {
      throw new Error(`Malformed notification entry: ${JSON.stringify(entry)}`);
    }
    return { kind, title, readAt, count, actionType };
  });
}

test("a member keeps background updates in Activity and their own action confirmations in toasts", async ({ world, user, agent, probe, step, evidence }) => {
  const candidateId = world.candidate.sessionId;
  const center = async () => listed(await agent.run("notifications.list"));
  const closeCenter = async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.dom("[data-notification-panel]"), {
      within: 10_000, label: "Activity popover closes", until: (value) => value.elements.length === 0,
    });
  };
  const quietBell = async () => {
    const state = await world.bell();
    expect(state).toEqual({ label: "Activity", unread: false });
    await user.notSee({ role: "button", label: /Mark all.*read/i });
    return state;
  };
  const unreadBell = async (count: number) => {
    const state = await probe.eventually(() => world.bell(), {
      within: 10_000, label: "the bell shows unread Activity", until: (value) => value.unread,
    });
    expect(state).toEqual({ label: `Activity, ${count} unread`, unread: true });
    return state;
  };

  await step("before: Activity shows the quiet bell empty state without an unread count", async () => {
    expect(await center()).toEqual([]);
    await user.click(bell);
    await user.see(emptyTitle);
    await user.see({ text: "When something is shared with you or changes, it shows here." });
    await user.notSee({ role: "button", label: "View all" });
    const state = await quietBell();
    evidence.recordAssertionEvidence("An empty Activity stays quiet", `0 entries; bell “${state.label}”; unread indicator ${state.unread}; Nothing new is visible and there is no View all (Paper A4)`, true);
    await user.screenshot();
    await closeCenter();
  });

  if (world.engine !== "v2") {
    await step("archiving a conversation confirms with Undo without adding Activity", async () => {
      const archiveButton: Target = { role: "button", label: "Archive session", testId: `session-archive-${candidateId}` };
      await user.hover({ testId: `sidebar-session-${candidateId}` });
      await user.click(archiveButton);
      await user.see({ text: `Session archived: ${world.candidate.title}` }, { timeoutMs: 30_000 });
      await user.see(undoButton);
      const stamps = await probe.eventually(() => world.archivedAt(), {
        within: 30_000, label: "conversation archived on the server", until: (value) => value[candidateId] > 0,
      });
      expect(await center()).toEqual([]);
      await quietBell();
      evidence.recordAssertionEvidence("Archive stays toast-only", `Archived timestamp ${stamps[candidateId]}; 0 Activity entries; Undo is visible`, stamps[candidateId] > 0);
      await user.screenshot();
      await user.click(undoButton);
      await probe.eventually(() => world.archivedAt(), {
        within: 30_000, label: "Undo restores the conversation", until: (value) => value[candidateId] === 0,
      });
      expect(await center()).toEqual([]);
    });
  }

  await step("after: background updates stay available without interrupting the conversation", async () => {
    expect(await world.providerSync([{ id: "eng-278-sync-a", name: "Activity provider A", providerId: "eng-278-a" }])).toBe(1);
    await probe.eventually(center, {
      within: 10_000, label: "background update reaches Activity", until: (value) => value.length === 1,
    });
    expect(await world.providerSync([{ id: "eng-278-sync-b", name: "Activity provider B", providerId: "eng-278-b" }])).toBe(1);
    const merged = await probe.eventually(center, {
      within: 10_000, label: "background provider updates coalesce", until: (value) => value[0]?.title === "2 new providers available",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "providers", actionType: "open-model-picker" });
    await user.notSee({ text: "2 new providers available" });
    const unread = await unreadBell(1);
    await world.providerSync([{ id: "eng-278-sync-a", name: "Activity provider A", providerId: "eng-278-a" }]);
    expect(await center()).toEqual(merged);
    await user.click(bell);
    await user.see({ text: "2 new providers available" });
    await user.see({ role: "button", label: "Select a model" });
    expect((await probe.dom("[data-notification-panel] [data-activity-unread]")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Background notices arrive quietly with an unread dot", `3 deliveries produce ${merged.length} entry for 2 providers; nothing pops up; bell “${unread.label}”; the row carries the dot`, true);
    await user.screenshot();
    await closeCenter();
  });

  await step("closing Activity marks it read, and reloading keeps the same history and read state", async () => {
    const before = await center();
    await quietBell();
    await user.reload();
    await probe.eventually(center, {
      within: 30_000, label: "background history restores", until: (value) => value.length === before.length,
    });
    await quietBell();
    await user.click(bell);
    await user.see({ text: "You’re caught up" });
    await user.see({ text: "2 new providers available" });
    expect((await probe.dom("[data-notification-panel] [data-activity-unread]")).elements).toHaveLength(0);
    expect((await center()).map(({ readAt: _readAt, ...entry }) => entry)).toEqual(before.map(({ readAt: _readAt, ...entry }) => entry));
    await closeCenter();
    await user.reload();
    await probe.eventually(center, {
      within: 30_000, label: "viewed history restores unchanged", until: (value) => value.length === before.length,
    });
    await user.click(bell);
    await user.see({ text: "2 new providers available" });
    await quietBell();
    evidence.recordAssertionEvidence("Read state survives reloads without changing history", `1 background entry is unchanged across 2 reloads; closing the popover cleared the dot; it shows You’re caught up; no mark-all-read control`, true);
    await user.screenshot();
  });

  await step("View all opens a normal Activity page with the conversation sidebar", async () => {
    await user.click({ role: "button", label: "View all" });
    await user.see({ role: "button", label: "All" });
    await user.see({ text: "2 new providers available" });
    await user.see({ role: "button", label: "New session" });
    for (const label of ["All", "Skills", "Plugins", "Connections"]) {
      await user.see({ role: "button", label });
    }
    const route = await probe.hash();
    expect(route).toMatch(/\/activity\/?$/);
    expect((await probe.dom("[data-notification-panel]")).elements).toHaveLength(0);
    await quietBell();
    evidence.recordAssertionEvidence("Activity has a full page, not a settings sheet", `Route ${route}; 4 filters (Paper A2); conversation sidebar visible; 0 open popovers`, true);
    await user.screenshot();
  });

  await step("the same background update remains reachable with the sidebar hidden", async () => {
    await user.click({ testId: "sidebar-sidebar-toggle" });
    await probe.eventually(() => probe.dom("[data-session-header] [data-notification-bell]"), {
      within: 5_000, label: "Activity bell moves to the main titlebar", until: (value) => value.elements.length === 1,
    });
    await user.click(bell);
    await user.see({ text: "2 new providers available" });
    await quietBell();
    evidence.recordAssertionEvidence("Hiding the sidebar keeps Activity reachable", `1 titlebar bell; 1 preserved background update; no unread dot`, true);
    await user.screenshot();
    await closeCenter();
    await user.click({ testId: "main-sidebar-toggle" });
  });
});
