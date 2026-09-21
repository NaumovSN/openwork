import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelPicker, modelPickerEffortWeb } from "../worlds/chat.ts";

const test = spec.world(modelPicker, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

test("a signed-in member keeps Auto and BYOK accessible while organizing pins without losing a draft", async ({ world, user, probe, step }) => {
  const draft = "Keep this draft while choosing a model.";
  const picker = '[data-testid="composer-model-picker"]';
  const key = (model: { providerID: string; modelID: string }) => `${model.providerID}:${model.modelID}`;
  const option = (model: { providerID: string; modelID: string }) => ({ testId: `model-option-${model.providerID}-${model.modelID}` });
  const selected = async (model: { providerID: string; modelID: string }) => {
    expect((await probe.dom(`${picker} [data-checked="true"]`)).elements).toHaveLength(1);
    expect((await probe.dom(`${picker} [data-model-key="${key(model)}"][data-checked="true"]`)).elements).toHaveLength(1);
  };
  const pins = async () => (await probe.dom(`${picker} [data-slot="command-group"]:first-child [data-model-key] [title]`)).elements.map((element) => element.text);
  const rememberedSelection = async (model: { providerID: string; modelID: string }) => {
    expect(await probe.storage("openwork.sessionModels.v1")).toMatchObject({
      [world.session.sessionId]: { model },
    });
  };
  const noPurchase = async () => {
    await user.notSee({ role: "button", label: /subscribe|upgrade|purchase|buy credits/i });
    await user.notSee({ role: "link", label: /subscribe|upgrade|purchase|buy credits/i });
    await user.notSee({ text: "One subscription unlocks these in every workspace." });
    await user.notSee({ text: "Subscribe to use hosted frontier models in this workspace." });
    await user.notSee({ text: "Sign in to unlock hosted frontier models for your team." });
  };

  await step("before: Auto is selected and the draft stays beside one all-accessible picker", async () => {
    await user.type("composer", draft);
    await user.click({ role: "button", label: "Change model" });
    await user.see(option(world.auto));
    await user.click(option(world.auto));
    await probe.eventually(() => probe.dom(picker), {
      within: 5_000, label: "Auto selection finishes closing the picker", until: (snapshot) => snapshot.elements.length === 0,
    });
    await user.see({ role: "button", label: "Change model" }, { text: /^Auto$/ });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ label: "Search all models" });
    await user.see(option(world.auto), { text: /Free · OpenWork picks the model/ });
    await user.see(option(world.byok));
    await user.see({ role: "button", label: "Connect a provider" });
    const groups = (await probe.dom(`${picker} [data-slot="command-group-label"]`)).elements.map((element) => element.text);
    expect(groups.slice(0, 3)).toEqual(["Pinned", "Recent", "OpenWork Models"]);
    expect(groups.slice(3)).toContain("BYOK provider");
    expect(groups.slice(3)).toEqual(groups.slice(3).sort((left, right) => left.localeCompare(right)));
    expect(await pins()).toEqual(["Organization witness", "Pinned witness", "Auto"]);
    for (const model of [world.organization, world.favorite, world.auto, world.recent, world.byok, { providerID: "openwork", modelID: "hosted-model" }]) {
      expect((await probe.dom(`${picker} [data-model-key="${key(model)}"]`)).elements).toHaveLength(1);
    }
    await selected(world.auto);
    await user.notSee({ role: "button", label: "All models" });
    await user.notSee({ text: "GPT-5.6 Luna" });
    await noPurchase();
    await user.hover(option(world.organization));
    await user.screenshot();
  });

  await step("pinning a BYOK model adds it after existing pins without switching away from Auto", async () => {
    await user.hover(option(world.byok));
    await user.click({ role: "button", label: "Pin model: BYOK witness" });
    await user.hover(option(world.byok));
    await user.see({ role: "button", label: "Unpin model: BYOK witness" });
    expect(await pins()).toEqual(["Organization witness", "Pinned witness", "BYOK witness", "Auto"]);
    await selected(world.auto);
    await user.see("composer", { text: draft });
    expect(await probe.storage("openwork.modelCollections.v1")).toMatchObject({ favorites: [world.favorite, world.byok] });
    await noPurchase();
    await user.screenshot();
  });

  await step("after: unpinning restores BYOK to its provider while organization and Auto pins remain fixed", async () => {
    await user.click({ role: "button", label: "Unpin model: BYOK witness" });
    await user.hover(option(world.byok));
    await user.see({ role: "button", label: "Pin model: BYOK witness" });
    expect(await pins()).toEqual(["Organization witness", "Pinned witness", "Auto"]);
    for (const fixed of [world.organization, world.auto]) {
      await user.rightClick(option(fixed));
      await user.see({ role: "menuitem", label: "Pinned" });
      expect((await probe.dom('[role="menuitem"][aria-disabled="true"]')).elements.some((element) => element.text === "Pinned")).toBe(true);
      await user.notSee({ role: "menuitem", label: "Unpin model" });
      await user.screenshot();
      await user.press("Escape");
      expect(await pins()).toEqual(["Organization witness", "Pinned witness", "Auto"]);
    }
    await user.notSee({ role: "button", label: "Unpin model: Auto" });
    await user.notSee({ role: "button", label: "Unpin model: Organization witness" });
    expect(await probe.storage("openwork.modelCollections.v1")).toMatchObject({ favorites: [world.favorite] });
    await selected(world.auto);
    await user.see("composer", { text: draft });
  });

  await step("a BYOK model remains selectable without a purchase and switching preserves the unsent draft", async () => {
    await user.click(option(world.byok));
    await user.see({ role: "button", label: "Change model" }, { text: /^BYOK witness$/ });
    await probe.eventually(() => probe.dom(picker), {
      within: 5_000, label: "model selection finishes closing the picker", until: (snapshot) => snapshot.elements.length === 0,
    });
    await user.notSee({ testId: "composer-model-picker" });
    await user.see("composer", { text: draft });
    await user.screenshot();
    await user.click({ role: "button", label: "Change model" });
    await selected(world.byok);
    await rememberedSelection(world.byok);
    expect(await probe.storage("openwork.modelCollections.v1")).toMatchObject({ recent: [world.byok, world.auto, world.recent] });
    await noPurchase();
    await user.screenshot();
  });

  await step("after: choosing Auto selects its actual model reference, not just its label, and sends nothing", async () => {
    await user.click(option(world.auto));
    await user.see({ role: "button", label: "Change model" }, { text: /^Auto$/ });
    await user.see("composer", { text: draft });
    await user.click({ role: "button", label: "Change model" });
    await selected(world.auto);
    expect(await probe.storage("openwork.modelCollections.v1")).toMatchObject({ recent: [world.auto, world.byok, world.recent] });
    await user.see(option(world.byok));
    await noPurchase();
    await rememberedSelection(world.auto);
    expect(await world.requests()).toEqual([]);
    await user.screenshot();
  });
});

const effortTest = spec.world(modelPickerEffortWeb, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

effortTest("MODEL-01 selected reasoning effort survives reload and reaches the native provider", async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  const runtime = await world.runtimeFacts();
  expect(runtime.browser).toContain("HeadlessChrome");
  expect(runtime.electronBridge).toBe(false);
  evidence.recordJsonArtifact("MODEL-01 headless runtime", runtime);
  const prefix = `/workspace/${world.workspace.workspaceId}/opencode2/api`;
  const status = await world.readNative("/experimental/engine-v2-preview/status");
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ running: true, chatRouting: true });
  const catalog = await world.readNative(`${prefix}/model`);
  expect(catalog.status).toBe(200);
  expect(catalog.body).toMatchObject({ data: expect.arrayContaining([
    expect.objectContaining({ id: world.modelId, providerID: world.providerId, variants: [{ id: "low" }, { id: "high" }, { id: "CustomExact" }, { id: "auto" }] }),
    expect.objectContaining({ id: "standard", providerID: world.providerId, variants: [] }),
    expect.objectContaining({ id: world.fastModelId, providerID: world.fastProviderId, variants: [{ id: "high" }, { id: world.fastDefaultVariant }, { id: world.fastHighVariant }] }),
  ]) });
  expect(JSON.stringify(catalog.body)).not.toMatch(/synthetic-(effort|fast)-key|"settings":|"providerOptions":|"headers":/);
  evidence.recordJsonArtifact("MODEL-01 native catalog", catalog);
  await step("Default leaves the closed trigger showing only the model", async () => {
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness$/ });
    await user.screenshot();
  });
  await user.click({ role: "button", label: "Change model" });
  await step("only advertised effort choices are selectable", async () => {
    await user.click({ role: "button", label: /^Thinking and effort/ });
    await user.see({ role: "button", label: "Default" });
    await user.see({ role: "button", label: "Low" });
    await user.notSee({ role: "button", label: /^Hidden/ });
    await user.click({ role: "button", label: "High" });
    await user.see({ testId: "model-effort" }, { text: /High/ });
    await user.screenshot();
  });
  await user.press("Escape");
  await user.type("composer", world.prompt);
  await user.click("Run task");
  await user.see({ text: "Air scatters blue light more strongly." }, { timeoutMs: 90_000 });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("High is persisted and reaches the real v2 provider request", async () => {
    const requests = await world.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: world.modelId, reasoningEffort: "high" });
    expect(await world.modelRequests()).toEqual([{ model: { providerID: world.providerId, id: world.modelId, variant: "high" } }]);
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "high" } } });
    evidence.recordJsonArtifact("MODEL-01 first request and native session", { requests, native });
    await user.reload();
    await user.see("Run task", { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ testId: "model-effort" }, { text: /High/ });
    await user.screenshot();
    await user.press("Escape");
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "reloaded effort reaches provider", until: (requests) => requests.length === 2 });
    expect((await world.requests()).map((request) => request.reasoningEffort)).toEqual(["high", "high"]);
    evidence.recordJsonArtifact("MODEL-01 reloaded provider requests", await world.requests());
  });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("a custom effort ID reaches native resolution without case changes", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Thinking and effort/ });
    await user.click({ role: "button", label: "CustomExact" });
    await user.see({ testId: "model-effort" }, { text: /CustomExact/ });
    await user.screenshot();
    await user.press("Escape");
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "custom effort reaches provider", until: (requests) => requests.length === 3 });
    expect((await world.requests()).map((request) => request.reasoningEffort)).toEqual(["high", "high", "low"]);
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "CustomExact" } } });
    evidence.recordJsonArtifact("MODEL-01 custom effort request and native session", { requests: await world.requests(), native });
  });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("a model without advertised variants keeps effort unavailable", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.type({ placeholder: "Search models..." }, "Standard witness");
    await user.click({ role: "option", label: /^Standard witness/ });
    await user.see({ role: "button", label: "Change model" }, { text: /Standard witness/ });
    await probe.eventually(() => probe.dom('[data-testid="composer-model-picker"]'), {
      within: 5_000, label: "model selection finishes closing the picker", until: (snapshot) => snapshot.elements.length === 0,
    });
    await user.notSee({ placeholder: "Search models..." });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ testId: "model-effort" }, { text: /Unavailable/ });
    const disabled = await probe.dom('[data-testid="composer-model-picker"] button:disabled');
    expect(disabled.elements.some((button) => button.text.includes("Thinking and effort") && button.text.includes("Unavailable"))).toBe(true);
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-testid="composer-model-picker"]'), {
      within: 5_000, label: "effort picker finishes closing", until: (snapshot) => snapshot.elements.length === 0,
    });
    await user.notSee({ testId: "model-effort" });
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "unsupported model omits effort", until: (requests) => requests.length === 4 });
    const requests = await world.requests();
    expect(requests[3]).toMatchObject({ model: "standard", reasoningEffort: null });
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    const modelRequests = await world.modelRequests();
    expect(modelRequests).toEqual([
      { model: { providerID: world.providerId, id: world.modelId, variant: "high" } },
      { model: { providerID: world.providerId, id: world.modelId, variant: "CustomExact" } },
      { model: { providerID: world.providerId, id: "standard" } },
    ]);
    // Native v2 canonicalizes an omitted variant to its internal default ID.
    expect(native.body).toMatchObject({ data: { model: { id: "standard", providerID: world.providerId, variant: "default" } } });
    evidence.recordJsonArtifact("MODEL-01 unsupported model request and native session", { requests, modelRequests, native });
    await user.see("Run task", { timeoutMs: 30_000 });
  });
  await step("returning to Default persists after reload without changing the model", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.type({ placeholder: "Search models..." }, "Reasoning witness");
    await user.click({ role: "option", label: /^Reasoning witness/ });
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Thinking and effort/ });
    await user.click({ role: "button", label: "High" });
    await user.see({ testId: "model-effort" }, { text: /High/ });
    await user.click({ role: "button", label: /^Thinking and effort/ });
    await user.click({ role: "button", label: "Default" });
    await user.press("Escape");
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness$/ });
    await user.reload();
    await user.see("Run task", { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness$/ });
    await user.screenshot();
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "Default reaches provider after reload", until: (requests) => requests.length === 5 });
    expect((await world.requests())[4]).toMatchObject({ model: world.modelId, reasoningEffort: null });
    await user.see("Run task", { timeoutMs: 30_000 });
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "default" } } });
    evidence.recordJsonArtifact("MODEL-01 Default after reload", native);
    await user.click({ role: "button", label: "Change model" });
    await user.see({ testId: "model-effort" }, { text: /Default/ });
    await user.click({ role: "button", label: /^Thinking and effort/ });
    await user.see({ role: "button", label: "Default" });
    await user.see({ role: "button", label: "Low" });
    await user.see({ role: "button", label: "High" });
    await user.see({ role: "button", label: "CustomExact" });
    await user.see({ role: "button", label: "Auto" });
    await user.screenshot();
    await user.click({ role: "button", label: "Auto" });
    await user.see({ testId: "model-effort" }, { text: /Auto/ });
    await user.reload();
    await user.see("Run task", { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness$/ });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ testId: "model-effort" }, { text: /Auto/ });
    await user.screenshot();
    await user.press("Escape");
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "explicit Auto reaches provider after reload", until: (requests) => requests.length === 6 });
    expect((await world.requests())[5]).toMatchObject({ model: world.modelId, reasoningEffort: "low" });
    await user.see("Run task", { timeoutMs: 30_000 });
    const explicit = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(explicit.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "auto" } } });
    evidence.recordJsonArtifact("MODEL-01 explicit auto variant after reload", explicit);
  });
  await step("Default effort and Fast mode remain independently selectable after reload", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.type({ placeholder: "Search models..." }, "Fast witness");
    await user.click({ role: "option", label: /^Fast witness/ });
    await user.see({ role: "button", label: "Change model" }, { text: /^Fast witness$/ });
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Thinking and effort/ });
    await user.click({ role: "button", label: "Default" });
    await user.click({ role: "switch", label: "Fast mode" });
    expect((await probe.dom('[role="switch"][aria-label="Fast mode"][aria-checked="true"]')).elements).toHaveLength(1);
    await user.screenshot();
    await user.reload();
    await user.see("Run task", { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Change model" }, { text: /^Fast witness$/ });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ role: "switch", label: "Fast mode" });
    expect((await probe.dom('[role="switch"][aria-label="Fast mode"][aria-checked="true"]')).elements).toHaveLength(1);
    await user.screenshot();
    await user.click({ role: "button", label: /^Thinking and effort/ });
    await user.see({ role: "button", label: "Default" });
    const pressed = await probe.dom('[data-slot="model-thinking-submenu"] button[aria-pressed="true"]');
    expect(pressed.elements.map((button) => button.text)).toEqual(["Default"]);
    await user.screenshot();
    await user.press("Escape");
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "Default plus Fast reaches provider", until: (requests) => requests.length === 7 });
    expect((await world.requests())[6]).toMatchObject({ model: world.fastModelId, reasoningEffort: "medium" });
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.fastModelId, providerID: world.fastProviderId, variant: world.fastDefaultVariant } } });
    evidence.recordJsonArtifact("MODEL-01 Default plus Fast native request", { native, requests: await world.requests() });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Thinking and effort/ });
    await user.click({ role: "button", label: "High" });
    await user.see({ testId: "model-effort" }, { text: /High/ });
    expect((await probe.dom('[role="switch"][aria-label="Fast mode"][aria-checked="true"]')).elements).toHaveLength(1);
    await user.screenshot();
  });
});
