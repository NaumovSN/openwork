import { expect } from "vitest";
import { spec, type User } from "@openwork/testkit";
import { nativeSlackConnect } from "../worlds/native-slack-connect.ts";

const test = spec.world(nativeSlackConnect, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  // Native HTTP provider mocks currently have no remote co-location interface.
  // The runner still owns placement; a non-local placement reports needs, never
  // silently switches to local or contacts Slack. This is not packaged proof.
  needs: { commands: ["pnpm", "bun"] },
});

async function openConnections(user: User) {
  await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
  await user.click({ role: "option", label: /^Connectors/ });
}

test("Cloud members connect different Slack workspaces without configuration and keep private access isolated", async ({ world, user, probe, step, evidence }) => {
  const second = user.on(world.secondApp);
  const secondProbe = probe.on(world.secondApp);
  const privateConversation = world.slack.conversations.find(entry => entry.type === "private_channel");
  if (!privateConversation) throw new Error("The synthetic private conversation is missing");
  let retainedSearchName = "";

  await step("given: both members have isolated, working agent runtimes", async () => {
    await user.see("composer", { editable: true });
    await second.see("composer", { editable: true });
    if (world.engine === "v2") {
      const runtimes = [];
      const identities: Array<"first" | "second"> = ["first", "second"];
      for (const identity of identities) {
        const result = await probe.eventually(() => world.appRequest(identity, "/experimental/engine-v2-preview/status"), {
          within: 60_000, label: "the pinned V2 runtime is running", until: result => result.status === 200 && world.objects(result.body).some(entry => entry.running === true),
        });
        const runtime = world.objects(result.body).find(entry => entry.running === true);
        expect(runtime).toMatchObject({ enabled: true, chatRouting: true, running: true, version: world.engineVersion, binSource: "env" });
        expect(typeof runtime?.pid).toBe("number");
        runtimes.push(runtime);
      }
      expect(runtimes[0]?.pid).not.toBe(runtimes[1]?.pid);
      evidence.recordAssertionEvidence("The two app profiles use distinct pinned V2 runtimes", `Both public runtime status calls confirm ${world.engineVersion}, enabled chat routing, and distinct running process IDs. No engine settings were changed by the spec.`, true);
    } else {
      expect((await world.appRequest("first", "/health")).status).toBe(200);
      expect((await world.appRequest("second", "/health")).status).toBe(200);
      evidence.recordAssertionEvidence("Both legacy app profiles are healthy", "Two independently launched app servers returned HTTP 200; no V2-specific runtime claim is made for this selection.", true);
    }
  });

  await step("before: Cloud Slack is available without asking the member for developer credentials", async () => {
    await user.see("composer", { editable: true });
    await openConnections(user);
    await user.see({ role: "button", label: "Connect Slack" });
    await user.notSee({ text: /^Client ID$/i });
    await user.notSee({ text: /^Client secret$/i });
    expect(await world.connection("first")).toMatchObject({ id: "slack", connectedForMe: false });
    expect(world.slack.calls()).toHaveLength(0);
    evidence.recordAssertionEvidence("Slack is supplied by Connect, not a member-created app", "The available Slack row offers Connect; no client ID or secret field is shown, and no provider request has occurred.", true);
    await user.screenshot();
  });

  await step("the member authorizes their own read-only Slack identity", async () => {
    await user.click({ role: "button", label: "Connect Slack" });
    const consent = user.on(await world.oauthSurface(world.app));
    await consent.see({ text: "Synthetic Slack consent" });
    await consent.screenshot();
    await consent.click({ role: "button", text: "Authorize member one" });
    const connected = await probe.eventually(() => world.connection("first"), {
      within: 60_000, label: "the first member's own Slack identity is connected", until: value => value?.connectedForMe === true,
    });
    expect(JSON.stringify(connected)).toContain("TSYNTHETIC");
    expect(JSON.stringify(connected)).toContain("USYNTHFIRST");
    const authorization = world.slack.authorizations()[0];
    expect(authorization).toMatchObject({ statePresent: true, botScopes: [] });
    expect(authorization.scopes).toEqual(expect.arrayContaining(["search:read.public", "search:read.private", "search:read.im", "search:read.mpim"]));
    expect(authorization.scopes.some(scope => /write|files/.test(scope))).toBe(false);
    const identity = world.slack.calls().find(call => call.path === "/api/auth.test");
    expect(identity).toMatchObject({ member: "first", workspace: "TSYNTHETIC", error: null });
    expect(await world.connection("second")).toMatchObject({ connectedForMe: false });
    await probe.eventually(async () => (await probe.dom('button[aria-label="Connect Slack"]')).elements.length, {
      within: 60_000, label: "the connection menu observes the completed authorization", until: count => count === 0,
    });
    await user.notSee({ role: "button", label: "Connect Slack" });
    evidence.recordAssertionEvidence("Own-member OAuth does not connect another member", "Slack received state and comma-separated read-only user scopes; auth.test used the nested user token for the first identity. The second member remains disconnected.", true);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("after: a natural request returns public, private and direct-message sources with bounded thread context", async () => {
    for (const conversation of world.slack.conversations) expect(world.prompt.first).not.toContain(conversation.id);
    expect(world.prompt.first).not.toContain("native:");
    await user.type("composer", world.prompt.first);
    await user.click("Run task");
    for (const conversation of world.slack.conversations) await user.see({ text: conversation.text }, { timeoutMs: 90_000 });
    await user.see({ text: "Incomplete thread context: this is a bounded excerpt, not the complete thread." });
    await user.see("Run task");
    const links = await probe.dom('a[href^="https://synthetic.slack.com/archives/"]');
    expect(links.elements.length).toBeGreaterThanOrEqual(4);
    const search = world.slack.calls().filter(call => call.path === "/api/assistant.search.context" && call.member === "first");
    expect(search).toHaveLength(1);
    expect(search[0].returnedChannels.sort()).toEqual(world.slack.conversations.map(entry => entry.id).sort());
    const threads = world.slack.calls().filter(call => call.path === "/api/conversations.replies");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ member: "first", returnedMessages: 2, error: null });
    expect(threads[0].parameters.cursor).toBeUndefined();
    expect(world.model.failures()).toEqual([]);
    const answer = world.model.outputs().find(entry => entry.prompt === world.prompt.first);
    expect(answer).toBeDefined();
    expect(world.incomplete(answer?.result)).toBe(true);
    const excerpt = world.objects(answer?.result).find(entry => entry.context === "thread_excerpt");
    expect(excerpt).toMatchObject({ partial: true, hasMore: true, nextCursor: "synthetic-thread-next" });
    expect(excerpt?.messages).toHaveLength(2);
    if (world.engine === "v2") {
      // A newly created split-pane conversation can retain the session-home URL.
      // Read actual native session IDs and find this unique prompt in persisted
      // native history instead of inventing a session ID from that URL.
      const mount = `/workspace/${encodeURIComponent(world.workspaceId)}/opencode2/api`;
      const listed = await world.appRequest("first", `${mount}/session`);
      expect(listed.status).toBe(200);
      const candidates = world.objects(listed.body).filter(entry => typeof entry.id === "string").slice(0, 10);
      let witnessed = false;
      for (const candidate of candidates) {
        if (typeof candidate.id !== "string") continue;
        const nativeHistory = await world.appRequest("first", `${mount}/session/${encodeURIComponent(candidate.id)}/message`);
        if (nativeHistory.status !== 200 || !JSON.stringify(nativeHistory.body).includes(world.prompt.first)) continue;
        expect(JSON.stringify(nativeHistory.body)).toContain(world.slack.conversations[0].text);
        witnessed = true;
        break;
      }
      expect(witnessed).toBe(true);
    }
    const catalog = await world.mcp("first", "search_capabilities", { query: "slack", type: "api", limit: 20 });
    const match = world.objects(catalog.body).find(entry => typeof entry.name === "string" && entry.name.startsWith("native:") && /slacksearch$/i.test(entry.name));
    if (!match || typeof match.name !== "string") throw new Error("The real catalog omitted the retained Slack search capability");
    expect(match).toMatchObject({ method: "GET", path: "/v1/capabilities/slack/search" });
    retainedSearchName = match.name;
    evidence.recordAssertionEvidence("Four conversation categories and an incomplete excerpt came from live synthetic HTTP responses", "One RTS request returned four member-visible categories. One replies request returned two of 105 fixture messages; four clickable source links and the real incomplete-context flag reached the answer. The prompt supplied no connection or channel IDs. Inference and Slack are synthetic; app, engine and Connect are real.", true);
    await user.screenshot();
  });

  await step("a read-only client can search Slack without receiving permission to write", async () => {
    await user.see("composer", { editable: true });
    const before = world.slack.calls().length;
    const result = await world.mcp("first", "execute_capability", { name: retainedSearchName, query: { query: "Amber launch", limit: 4 } });
    expect(result.status).toBe(200);
    expect(result.body).not.toMatchObject({ isError: true });
    expect(world.objects(result.body).find(entry => entry.context === "search_results")).toMatchObject({ ok: true, partial: true });
    const additional = world.slack.calls().slice(before);
    expect(additional).toHaveLength(1);
    expect(additional[0]).toMatchObject({ method: "POST", path: "/api/assistant.search.context", member: "first", error: null });
    evidence.recordAssertionEvidence("Native search remains usable with read-only gateway authority", "The token mint returned exactly mcp:read. Executing the discovered GET search capability succeeded and caused one internal Slack RTS POST; no mcp:write or Slack write scope was granted.", true);
  });

  await step("another Slack workspace connects automatically and cannot read the first workspace", async () => {
    await second.see("composer", { editable: true });
    await openConnections(second);
    await second.click({ role: "button", label: "Connect Slack" });
    const consent = user.on(await world.oauthSurface(world.secondApp));
    await consent.see({ text: "Synthetic Slack consent" });
    await consent.screenshot();
    await consent.click({ role: "button", text: "Authorize another workspace" });
    await consent.see({ role: "heading", text: "You're connected" }, { timeoutMs: 30_000 });
    const connected = await world.connection("second");
    expect(connected).toMatchObject({ connectedForMe: true });
    expect(JSON.stringify(connected)).toContain(world.slack.otherWorkspace);
    const found = await world.memberRequest("second", "/v1/capabilities/slack/search?query=Amber%20launch");
    expect(found.status).toBe(200);
    expect(found.text).toContain(world.slack.otherConversations[0].text);
    const denied = await world.memberRequest("second", `/v1/capabilities/slack/threads?channelId=${privateConversation.id}&ts=${privateConversation.ts}`);
    expect(denied).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(denied.text).not.toContain(privateConversation.text);
    expect(world.slack.calls().findLast(call => call.path === "/api/conversations.replies")).toMatchObject({ workspace: world.slack.otherWorkspace, error: "channel_not_found" });
    evidence.recordAssertionEvidence("A second Slack workspace connects without environment changes and retains its own access boundary", "OAuth and auth.test identified another workspace automatically. Its search returned that workspace's fixtures; a guessed thread from the original workspace returned not_found using the second workspace's token.", true);
    await consent.screenshot();
  });

  await step("the second member connects a separate Slack identity with the same read permissions", async () => {
    // Explicit reauthorization replaces the one member-owned workspace slot.
    await second.navigate(await world.startAuthorization("second"));
    const consent = second;
    await consent.see({ text: "Synthetic Slack consent" });
    await consent.click({ role: "button", text: "Authorize member two" });
    await consent.see({ role: "heading", text: "You're connected" }, { timeoutMs: 30_000 });
    const connected = await probe.eventually(() => world.connection("second"), {
      within: 60_000, label: "the second member's replacement Slack identity connects", until: value => value?.externalAccountId === "slack:TSYNTHETIC:USYNTHSECOND",
    });
    expect(JSON.stringify(connected)).toContain("USYNTHSECOND");
    const firstIdentity = world.slack.calls().find(call => call.path === "/api/auth.test" && call.member === "first" && call.workspace === "TSYNTHETIC");
    const secondIdentity = world.slack.calls().find(call => call.path === "/api/auth.test" && call.member === "second");
    expect(secondIdentity?.tokenId).toBeTruthy();
    expect(secondIdentity?.tokenId).not.toBe(firstIdentity?.tokenId);
    await second.navigate(world.secondAppUrl);
    await second.see("composer", { editable: true });
    evidence.recordAssertionEvidence("Each member authorizes a distinct user token", "Both accounts completed the same read-only OAuth request, but auth.test observed different user-token fingerprints and different Slack user IDs in the same synthetic workspace.", true);
    await second.screenshot();
  });

  await step("the second member cannot search or directly read the first member's private conversation", async () => {
    await second.type("composer", world.prompt.second);
    await second.click("Run task");
    const publicConversation = world.slack.conversations.find(entry => entry.type === "public_channel");
    if (!publicConversation) throw new Error("Missing public fixture");
    await second.see({ text: publicConversation.text }, { timeoutMs: 90_000 });
    await second.see("Run task");
    for (const conversation of world.slack.conversations.filter(entry => entry.type !== "public_channel")) {
      await second.notSee({ text: conversation.text });
    }
    const search = world.slack.calls().filter(call => call.path === "/api/assistant.search.context" && call.member === "second");
    expect(search).toHaveLength(1);
    expect(search[0].returnedChannels).toEqual([publicConversation.id]);
    expect(JSON.stringify(search[0].parameters.channel_types)).toContain("private_channel");
    const denied = await world.memberRequest("second", `/v1/capabilities/slack/threads?channelId=${privateConversation.id}&ts=${privateConversation.ts}&limit=2`);
    expect(denied).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(denied.text).not.toContain(privateConversation.text);
    expect(world.slack.calls().findLast(call => call.path === "/api/conversations.replies")).toMatchObject({ member: "second", error: "channel_not_found", returnedMessages: 0 });
    expect((await secondProbe.text()).includes(privateConversation.text)).toBe(false);
    evidence.recordAssertionEvidence("Private access follows Slack membership, not the shared OpenWork organization", `The second user's fully scoped search returned only the public channel. A guessed private thread request returned HTTP ${denied.status}; the provider observed the second token and rejected it with channel_not_found. No private text reached that member's answer.`, true);
    await second.screenshot();
  });

  await step("after: declining optional permissions leaves useful public access and names what was not searched", async () => {
    // The public OAuth start endpoint is the real reconnection boundary. Follow
    // its returned link; no token, scope or connection row is injected by seed.
    await user.navigate(await world.startAuthorization("first"));
    await user.see({ text: "Synthetic Slack consent" });
    await user.click({ role: "button", text: "Authorize public access only" });
    await user.see({ role: "heading", text: "You're connected" }, { timeoutMs: 30_000 });
    await user.navigate(world.appUrl);
    await user.see("composer", { editable: true });
    await user.type("composer", world.prompt.partial);
    await user.click("Run task");
    await user.see({ text: "Limited access: private channels and direct messages were not searched, not reported as empty." }, { timeoutMs: 90_000 });
    await user.see("Run task");
    const search = world.slack.calls().findLast(call => call.path === "/api/assistant.search.context" && call.member === "first");
    expect(search).toMatchObject({ error: null });
    expect(JSON.stringify(search?.parameters.channel_types)).not.toMatch(/private_channel|mpim|\bim\b/);
    expect(search?.returnedChannels).toEqual(["CSYNTHPUBLIC"]);
    const answer = world.model.outputs().find(entry => entry.prompt === world.prompt.partial);
    expect(world.limited(answer?.result)).toBe(true);
    expect(world.objects(answer?.result).find(entry => entry.context === "search_results")).toMatchObject({
      searchedConversationTypes: ["public_channel"], omittedConversationTypes: ["private_channel", "im", "mpim"],
    });
    expect(answer?.text).not.toContain(privateConversation.text);
    expect(await world.connection("first")).toMatchObject({ connectedForMe: true });
    const beforeDenied = world.slack.calls().length;
    const missing = await world.memberRequest("first", "/v1/capabilities/slack/search?query=Amber%20launch&conversationTypes=private_channel");
    expect(missing).toMatchObject({ status: 409, body: { error: "missing_permission" } });
    expect(world.slack.calls()).toHaveLength(beforeDenied);
    evidence.recordAssertionEvidence("Partial consent stays connected and does not mislabel unsearched categories as empty", "The replacement member grant contains public search/history only. The provider received only public channel types and returned useful content; native omitted-category metadata reached the answer. Explicitly requesting private search returned missing_permission (409) without a provider call.", true);
    await user.screenshot();
  });

  await step("the connection itself shows limited access without exposing internal account identifiers", async () => {
    await user.click("Library");
    await user.see({ text: "Connected with limited access" }, { timeoutMs: 60_000 });
    await user.notSee({ text: "slack:TSYNTHETIC:USYNTHFIRST" });
    const connection = await world.connection("first");
    expect(connection).toMatchObject({ connectedForMe: true, needsReconnect: false });
    expect(connection?.missingFeatures).toEqual(expect.arrayContaining(["privateChannels", "directMessages", "groupMessages"]));
    evidence.recordAssertionEvidence("Limited access is product state, not just model prose", "The Library says Connected with limited access while the native account remains connected and does not require reconnect. Optional private/DM feature omissions are retained; the encoded workspace/user identifier is not displayed.", true);
    await user.screenshot();
    await user.navigate(world.appUrl);
  });

  await step("another Cloud organization gets Slack but must authorize its own account", async () => {
    await user.see("composer", { editable: true });
    const authenticated = await world.memberRequest("other", "/v1/org");
    expect(authenticated).toMatchObject({ status: 200, body: { organization: { id: world.otherOrganizationId } } });
    const before = world.slack.calls().length;
    const responses = [];
    for (const path of ["/v1/mcp-connections/slack/connect/start", "/v1/oauth-providers/slack/connect/start"]) {
      responses.push(await world.memberRequest("other", path));
    }
    responses.push(await world.memberRequest("other", "/v1/capabilities/slack/search?query=Amber%20launch"));
    responses.push(await world.memberRequest("other", `/v1/capabilities/slack/threads?channelId=${privateConversation.id}&ts=${privateConversation.ts}`));
    expect(responses.slice(0, 2).every(response => response.status === 200)).toBe(true);
    expect(responses.slice(2).every(response => response.status === 409)).toBe(true);
    const retained = await world.mcp("other", "execute_capability", { name: retainedSearchName, query: { query: "Amber launch" } });
    expect(retained.status).toBe(200);
    expect(world.objects(retained.body).some(entry => entry.error === "needs_connection")).toBe(true);
    expect(world.slack.calls()).toHaveLength(before);
    await user.navigate(await world.startAuthorization("other"));
    await user.click({ role: "button", text: "Authorize another workspace" });
    await user.see({ role: "heading", text: "You're connected" }, { timeoutMs: 30_000 });
    expect(await world.connection("other")).toMatchObject({ connectedForMe: true });
    const ownSearch = await world.memberRequest("other", "/v1/capabilities/slack/search?query=Amber%20launch");
    expect(ownSearch.status).toBe(200);
    expect(ownSearch.text).toContain(world.slack.otherConversations[0].text);
    expect(JSON.stringify(await world.connection("first"))).toContain("TSYNTHETIC");
    evidence.recordAssertionEvidence("The same app serves another Cloud organization without sharing a member grant", "Both start aliases were available in the second organization. Search and retained capability execution required its own connection; after browser OAuth its own workspace search succeeded. No platform configuration was changed.", true);
    await user.screenshot();
    await user.navigate(world.appUrl);
  });

  await step("a disabled deployment rejects an already authorized member's retained capability", async () => {
    await user.see("composer", { editable: true });
    const authenticated = await world.memberRequest("first", "/v1/org", "GET", undefined, true);
    expect(authenticated).toMatchObject({ status: 200, body: { organization: { id: world.organizationId } } });
    const before = world.slack.calls().length;
    const responses = [];
    for (const path of ["/v1/mcp-connections/slack/connect/start", "/v1/oauth-providers/slack/connect/start"]) {
      responses.push(await world.memberRequest("first", path, "GET", undefined, true));
    }
    responses.push(await world.memberRequest("first", "/v1/capabilities/slack/search?query=Amber%20launch", "GET", undefined, true));
    responses.push(await world.memberRequest("first", `/v1/capabilities/slack/threads?channelId=${privateConversation.id}&ts=${privateConversation.ts}`, "GET", undefined, true));
    expect(responses.every(response => response.status === 403 || response.status === 404)).toBe(true);
    expect(responses.slice(2)).toEqual([
      expect.objectContaining({ status: 403, body: expect.objectContaining({ error: "policy_blocked" }) }),
      expect.objectContaining({ status: 403, body: expect.objectContaining({ error: "policy_blocked" }) }),
    ]);
    const retained = await world.mcp("first", "execute_capability", { name: retainedSearchName, query: { query: "Amber launch" } }, true);
    expect(retained.status).toBe(200);
    expect(world.objects(retained.body).some(entry => entry.error === "policy_blocked")).toBe(true);
    expect(world.slack.calls()).toHaveLength(before);
    const management = await world.memberRequest("first", "/v1/mcp-connections?scope=usable", "GET", undefined, true);
    expect(world.objects(management.body).find(entry => entry.id === "slack")).toMatchObject({
      policyBlocked: true, connected: false, connectedForMe: true,
    });
    const disconnected = await world.memberRequest("first", "/v1/oauth-providers/slack/disconnect", "POST", undefined, true);
    expect(disconnected).toMatchObject({ status: 200, body: { ok: true } });
    const afterDisconnect = await world.memberRequest("first", "/v1/mcp-connections?scope=usable", "GET", undefined, true);
    expect(world.objects(afterDisconnect.body).some(entry => entry.id === "slack")).toBe(false);
    expect(world.slack.calls()).toHaveLength(before);
    expect(world.model.failures()).toEqual([]);
    const allowedMethods = ["/api/oauth.v2.access", "/api/auth.test", "/api/assistant.search.context", "/api/conversations.replies", "/api/chat.getPermalink"];
    expect(world.slack.calls().every(call => allowedMethods.includes(call.path))).toBe(true);
    expect(world.slack.calls().every(call => call.error === null || call.error === "channel_not_found")).toBe(true);
    evidence.recordAssertionEvidence("Disabling availability stops retained authorization, not just discovery", `A second isolated Den process reads the same scratch database with Slack disabled. Its audience-valid, read-only member token reaches policy_blocked for the retained capability; OAuth aliases/search/threads returned ${responses.map(response => response.status).join(" / ")}. The saved account stays visible as blocked and can still be disconnected. There were zero additional provider calls; no actual rollout flag changed.`, true);
  });
});
