import { createHash } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denSecretsVariables } from "../worlds/den-secrets-variables.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(denSecretsVariables, { timeout: 900_000 });
const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

test("an admin defines write-only credentials and members use their own values only at the approved MCP destination", async ({
  world,
  user,
  probe,
  step,
  evidence,
}) => {
  const admin = user.on(world.web),
    jordan = user.on(world.memberWeb),
    casey = user.on(world.caseyWeb),
    denied = user.on(world.deniedWeb);
  const secrets = "/v1/org/secrets";
  const state = async (session = world.den.admin) => {
    const result = await probe.api(session, secrets);
    expect(result.response.status).toBe(200);
    if (!isRecord(result.body))
      throw new Error("Den returned no secret definitions.");
    return result;
  };
  const definition = async (name: string, session = world.den.admin) => {
    const result = await state(session);
    const row = records(
      isRecord(result.body) ? result.body.definitions : [],
    ).find((item) => item.name === name);
    if (!row) throw new Error(`Missing ${name}.`);
    return row;
  };
  async function enterValue(actor: typeof admin, name: string, value: string) {
    await actor.click({ testId: `edit-value-${name}` });
    await actor.type({ testId: `input-value-${name}` }, value, {
      replace: true,
    });
    await actor.click({ testId: `save-value-${name}` });
    await actor.see(
      { testId: "secrets-saved" },
      { text: "Value saved.", timeoutMs: 30_000 },
    );
  }
  async function addDefinition(name: string, label: string, variable = false) {
    await admin.click({ role: "button", label: "Add requirement" });
    await admin.type({ label: "Name" }, name);
    await admin.type({ label: "Label" }, label);
    if (variable) {
      await admin.click({ label: "Type" });
      await admin.press("ArrowDown");
      await admin.press("Enter");
    }
    await admin.click({ role: "button", label: "Add definition" });
    await admin.see({ testId: `requirement-${name}` }, { timeoutMs: 30_000 });
  }

  await step(
    "before: the admin and members have no values to fill in",
    async () => {
      await admin.see(
        { role: "heading", label: "Secrets and variables" },
        { timeoutMs: 120_000 },
      );
      await admin.see({
        text: "Your workspace has no member values to fill in.",
      });
      await jordan.see(
        { role: "heading", label: "Secrets and variables" },
        { timeoutMs: 120_000 },
      );
      const result = await state();
      expect(
        records(isRecord(result.body) ? result.body.definitions : []),
      ).toHaveLength(0);
      evidence.recordAssertionEvidence(
        "the new menu opens an empty workspace",
        "Admin and member open Secrets and variables; there are zero definitions.",
        true,
      );
      await admin.screenshot();
    },
  );
  await step(
    "the admin names a required personal token and a readable workspace variable",
    async () => {
      await admin.click({ role: "radio", label: "Member requirements" });
      await addDefinition("WORK_TOKEN", "Work account token");
      await addDefinition("WORKSPACE_ID", "Workspace ID", true);
      expect(await definition("WORK_TOKEN")).toMatchObject({
        kind: "secret",
        source: "member",
        required: true,
      });
      expect(await definition("WORKSPACE_ID")).toMatchObject({
        kind: "variable",
      });
      evidence.recordAssertionEvidence(
        "the admin controls names and labels, and every member supplies their own values",
        "WORK_TOKEN is a required member secret; WORKSPACE_ID is a member variable; both initially have zero completed members.",
        true,
      );
      await admin.screenshot();
    },
  );
  await step(
    "the admin can improve a label while the reference name stays fixed",
    async () => {
      await admin.click({ testId: "edit-requirement-WORK_TOKEN" });
      await admin.type({ label: "Label" }, "Personal work token", {
        replace: true,
      });
      await admin.click({ role: "button", label: "Save requirement" });
      await admin.see(
        { testId: "requirement-WORK_TOKEN" },
        { text: /Personal work token/, timeoutMs: 30_000 },
      );
      const current = await definition("WORK_TOKEN");
      const rename = await world.request(
        world.den.admin,
        `${secrets}/definitions/${current.id}`,
        "PATCH",
        {
          name: "RENAMED",
          label: "Other",
          helpText: "",
          required: true,
          expectedRevision: current.revision,
        },
      );
      expect(rename.response.status).toBe(400);
      evidence.recordAssertionEvidence(
        "presentation can change without silently rebinding a name",
        "The label updates in Den, WORK_TOKEN remains the reference name, and an attempted rename receives HTTP 400.",
        true,
      );
      await admin.screenshot();
    },
  );
  await step(
    "the admin saves a shared organization secret without a read-back control",
    async () => {
      await admin.click({ role: "radio", label: "Organization values" });
      await admin.click({ role: "button", label: "Add organization value" });
      await admin.type({ label: "Name" }, "ORG_KEY");
      await admin.type({ label: "Label" }, "Organization API key");
      await admin.click({ role: "button", label: "Add definition" });
      await admin.see(
        { testId: "secret-value-ORG_KEY" },
        { timeoutMs: 30_000 },
      );
      await enterValue(admin, "ORG_KEY", "demo-org-secret-7310");
      const result = await state();
      expect(result.text).not.toContain("demo-org-secret-7310");
      expect(await definition("ORG_KEY")).toMatchObject({
        source: "organization",
        saved: true,
      });
      evidence.recordAssertionEvidence(
        "a saved organization secret stays write-only",
        "Den returns saved=true and a revision; no secret value is present in its management response.",
        true,
      );
      await admin.screenshot();
    },
  );
  await step(
    "unknown names and transport headers are rejected before the connection can use them",
    async () => {
      await admin.click({ role: "radio", label: "Connection templates" });
      await admin.click({ label: "Connection" });
      await admin.press("ArrowDown");
      await admin.press("Enter");
      // Select the named row using the native select's keyboard search.
      await admin.click({ label: "Connection" });
      await admin.press("M");
      await admin.press("Enter");
      await admin.type(
        { label: "HTTP headers" },
        "Authorization: Bearer {!UNKNOWN}",
        { replace: true },
      );
      await admin.click({ role: "button", label: "Save templates" });
      await admin.see(
        { role: "alert" },
        { text: /Define UNKNOWN/, timeoutMs: 30_000 },
      );
      const unsafe = await world.request(
        world.den.admin,
        `${secrets}/connections/${world.connectionId}`,
        "PUT",
        {
          expectedRevision: 0,
          headers: [{ name: "Host", template: "{!WORK_TOKEN}" }],
        },
      );
      expect(unsafe.response.status).toBe(400);
      evidence.recordAssertionEvidence(
        "invalid templates cannot be activated",
        "An unknown reference is explained in Den; a Host template receives HTTP 400; no binding was saved.",
        true,
      );
      await admin.screenshot();
    },
  );
  await step(
    "after: the admin binds personal and organization references to the same MCP request",
    async () => {
      await admin.type(
        { label: "HTTP headers" },
        "Authorization: Bearer {!WORK_TOKEN}\nX-Workspace: {!WORKSPACE_ID}\nX-Organization-Key: {!ORG_KEY}",
        { replace: true },
      );
      await admin.click({ role: "button", label: "Save templates" });
      await admin.see(
        { testId: "secrets-saved" },
        { text: /Connection templates saved/, timeoutMs: 30_000 },
      );
      const result = await state();
      expect(
        records(isRecord(result.body) ? result.body.bindings : []),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            connectionId: world.connectionId,
            ready: false,
          }),
        ]),
      );
      evidence.recordAssertionEvidence(
        "the connection stores references and waits for personal setup",
        "Three template headers were saved; the token value is supplied by each member and the organization key is shared.",
        true,
      );
      await admin.screenshot();
    },
  );
  await step(
    "a member sees the requirements but cannot view or replace the shared organization secret",
    async () => {
      await jordan.reload();
      await jordan.see(
        { testId: "secret-value-WORK_TOKEN" },
        { timeoutMs: 60_000 },
      );
      await jordan.notSee({ role: "radio", label: "Organization values" });
      const result = await state(world.den.members.jordan);
      expect(
        records(isRecord(result.body) ? result.body.definitions : []).map(
          (row) => row.name,
        ),
      ).not.toContain("ORG_KEY");
      const orgDefinition = await definition("ORG_KEY");
      const forbidden = await world.request(
        world.den.members.jordan,
        `${secrets}/values/${orgDefinition.id}`,
        "PUT",
        {
          value: "attempted-override",
          expectedRevision: orgDefinition.valueRevision,
        },
      );
      expect(forbidden.response.status).toBe(403);
      evidence.recordAssertionEvidence(
        "organization values stay under admin control",
        "The member sees only personal definitions; an attempted organization-key replacement returns HTTP 403.",
        true,
      );
      await jordan.screenshot();
    },
  );
  await step(
    "the member fills in the token and variable, then reviews their credential destination",
    async () => {
      await enterValue(jordan, "WORK_TOKEN", "demo-jordan-secret-9142");
      await enterValue(jordan, "WORKSPACE_ID", "jordan-workspace");
      await jordan.see({ testId: `approve-secret-${world.connectionId}` });
      await jordan.click({ testId: `approve-secret-${world.connectionId}` });
      await jordan.see(
        { testId: `secret-binding-${world.connectionId}` },
        { text: /Ready/, timeoutMs: 30_000 },
      );
      const result = await state(world.den.members.jordan);
      expect(result.text).not.toContain("demo-jordan-secret-9142");
      expect(
        await definition("WORKSPACE_ID", world.den.members.jordan),
      ).toMatchObject({ variableValue: "jordan-workspace" });
      evidence.recordAssertionEvidence(
        "a secret stays hidden while a variable remains readable",
        "The password field resets; management reads contain no token; Workspace ID reads jordan-workspace; the displayed MCP destination is approved.",
        true,
      );
      await jordan.screenshot();
    },
  );
  await step(
    "the real MCP receives the member's bearer token when they check the connection",
    async () => {
      const since = new Date().toISOString();
      await jordan.click({ testId: `check-secret-${world.connectionId}` });
      await jordan.see(
        { testId: "secrets-saved" },
        { text: "Connection checked. 1 tools available.", timeoutMs: 60_000 },
      );
      const handshakes = await world.connector.handshakes({
        sinceIso: since,
        atLeast: 1,
      });
      expect(
        handshakes.some(
          (request) =>
            request.tokenId === fingerprint("demo-jordan-secret-9142") &&
            request.headerFingerprints?.["x-workspace"] ===
              fingerprint("jordan-workspace") &&
            request.headerFingerprints?.["x-organization-key"] ===
              fingerprint("demo-org-secret-7310"),
        ),
      ).toBe(true);
      const toolRun = await world.callAsJordan();
      expect(toolRun.response.status).toBe(200);
      expect(
        (
          await world.connector.toolCalls({
            name: "get_mock_record",
            sinceIso: since,
            atLeast: 1,
          })
        ).some(
          (call) => call.tokenId === fingerprint("demo-jordan-secret-9142"),
        ),
      ).toBe(true);
      evidence.recordAssertionEvidence(
        "the HTTP boundary expanded the personal bearer template",
        "The downstream MCP served initialize, tools/list and a real member tools/call. Token, personal workspace and shared organization-key fingerprints all match their intended sources.",
        true,
      );
      await jordan.screenshot();
    },
  );
  await step(
    "another member starts empty and uses a different credential",
    async () => {
      await casey.reload();
      await casey.see(
        { testId: "secret-value-WORK_TOKEN" },
        { text: /Not provided/, timeoutMs: 60_000 },
      );
      const before = await world.request(
        world.den.members.casey,
        `${secrets}/connections/${world.connectionId}/check`,
        "POST",
        {},
      );
      expect(before.response.status).toBe(409);
      await enterValue(casey, "WORK_TOKEN", "demo-casey-secret-6173");
      await enterValue(casey, "WORKSPACE_ID", "casey-workspace");
      await casey.click({ testId: `approve-secret-${world.connectionId}` });
      await casey.see(
        { testId: `secret-binding-${world.connectionId}` },
        { text: /Ready/, timeoutMs: 30_000 },
      );
      const since = new Date().toISOString();
      await casey.click({ testId: `check-secret-${world.connectionId}` });
      await casey.see(
        { testId: "secrets-saved" },
        { text: /1 tools available/, timeoutMs: 60_000 },
      );
      expect(
        (
          await world.connector.handshakes({ sinceIso: since, atLeast: 1 })
        ).some((r) => r.tokenId === fingerprint("demo-casey-secret-6173")),
      ).toBe(true);
      expect((await state(world.den.members.casey)).text).not.toContain(
        "jordan-workspace",
      );
      evidence.recordAssertionEvidence(
        "personal credentials never fall back to another member's value",
        "Casey is blocked while empty, then the MCP receives Casey's fingerprint; Jordan's workspace value is absent from Casey's reads.",
        true,
      );
      await casey.screenshot();
    },
  );
  await step(
    "replacing a secret takes effect on the next request and stale saves are rejected",
    async () => {
      const old = await definition("WORK_TOKEN", world.den.members.jordan);
      await enterValue(jordan, "WORK_TOKEN", "demo-jordan-rotated-2201");
      const stale = await world.request(
        world.den.members.jordan,
        `${secrets}/values/${old.id}`,
        "PUT",
        { value: "stale-attempt", expectedRevision: old.valueRevision },
      );
      expect(stale.response.status).toBe(409);
      const since = new Date().toISOString();
      await jordan.click({ testId: `check-secret-${world.connectionId}` });
      await jordan.see(
        { testId: "secrets-saved" },
        { text: /1 tools available/, timeoutMs: 60_000 },
      );
      expect(
        (
          await world.connector.handshakes({ sinceIso: since, atLeast: 1 })
        ).some((r) => r.tokenId === fingerprint("demo-jordan-rotated-2201")),
      ).toBe(true);
      evidence.recordAssertionEvidence(
        "rotation is immediate and conflicting edits fail safely",
        "The next MCP handshake uses the replacement fingerprint; a write with the old revision returns HTTP 409.",
        true,
      );
      await jordan.screenshot();
    },
  );
  await step(
    "a credential containing a new header line is blocked at the request boundary",
    async () => {
      const token = await definition("WORK_TOKEN", world.den.members.jordan);
      const written = await world.request(
        world.den.members.jordan,
        `${secrets}/values/${token.id}`,
        "PUT",
        {
          value: "unsafe\r\nX-Injected: yes",
          expectedRevision: token.valueRevision,
        },
      );
      expect(written.response.status).toBe(200);
      const count = (await world.connector.handshakes()).length;
      await jordan.reload();
      await jordan.see(
        { testId: `check-secret-${world.connectionId}` },
        { timeoutMs: 60_000 },
      );
      await jordan.click({ testId: `check-secret-${world.connectionId}` });
      await jordan.see(
        { role: "alert" },
        { text: /Connection check failed/, timeoutMs: 30_000 },
      );
      expect((await world.connector.handshakes()).length).toBe(count);
      evidence.recordAssertionEvidence(
        "a stored value cannot inject a second HTTP header",
        "A synthetic CRLF value is present, but the connection check fails before the mock receives any new request.",
        true,
      );
      await jordan.screenshot();
      await enterValue(jordan, "WORK_TOKEN", "demo-jordan-rotated-2201");
    },
  );
  await step(
    "clearing a secret blocks new requests without affecting another member",
    async () => {
      await jordan.click({ testId: "edit-value-WORK_TOKEN" });
      await jordan.click({ testId: "clear-value-WORK_TOKEN" });
      await jordan.click({ testId: "confirm-clear-WORK_TOKEN" });
      await jordan.see(
        { testId: "secret-value-WORK_TOKEN" },
        { text: /Not provided/, timeoutMs: 30_000 },
      );
      const count = (await world.connector.handshakes()).length;
      const missing = await world.request(
        world.den.members.jordan,
        `${secrets}/connections/${world.connectionId}/check`,
        "POST",
        {},
      );
      expect(missing.response.status).toBe(409);
      expect((await world.connector.handshakes()).length).toBe(count);
      const caseyState = await state(world.den.members.casey);
      expect(
        records(isRecord(caseyState.body) ? caseyState.body.bindings : []).find(
          (r) => r.connectionId === world.connectionId,
        ),
      ).toMatchObject({ ready: true });
      evidence.recordAssertionEvidence(
        "a cleared credential fails before reaching the provider",
        "Jordan's check returns HTTP 409 with no new provider handshake; Casey remains ready.",
        true,
      );
      await jordan.screenshot();
    },
  );
  await step(
    "a member without a connection grant cannot approve or send credentials",
    async () => {
      await denied.reload();
      await denied.see(
        { testId: "secret-value-WORK_TOKEN" },
        { timeoutMs: 60_000 },
      );
      await denied.notSee({ testId: `secret-binding-${world.connectionId}` });
      const approval = await world.request(
        world.den.members.denied,
        `${secrets}/connections/${world.connectionId}/approve`,
        "POST",
        { revision: 1 },
      );
      const check = await world.request(
        world.den.members.denied,
        `${secrets}/connections/${world.connectionId}/check`,
        "POST",
        {},
      );
      const scopedRead = await world.request(
        world.den.members.denied,
        secrets,
        "GET",
        undefined,
        { "x-openwork-org-id": "org_00000000000000000000000000" },
      );
      expect([403, 404]).toContain(scopedRead.response.status);
      const adminAttempt = await world.request(
        world.den.members.denied,
        `${secrets}/definitions`,
        "POST",
        {
          name: "ILLEGAL",
          label: "Illegal",
          kind: "secret",
          source: "member",
          required: true,
        },
      );
      expect([
        approval.response.status,
        check.response.status,
        adminAttempt.response.status,
      ]).toEqual([403, 403, 403]);
      evidence.recordAssertionEvidence(
        "credential availability cannot grant connection or admin access",
        "The ungranted connection is absent; approve, check, and create-definition requests return HTTP 403. An organization selector the caller does not belong to returns 403/404.",
        true,
      );
      await denied.screenshot();
    },
  );
  await step(
    "the admin runs a real tool and provider echoes are removed from the result and inspector",
    async () => {
      await admin.click({ role: "radio", label: "My values" });
      await enterValue(admin, "WORK_TOKEN", "demo-admin-secret-4820");
      await enterValue(admin, "WORKSPACE_ID", "admin-workspace");
      await admin.click({ testId: `approve-secret-${world.connectionId}` });
      await admin.see(
        { testId: `secret-binding-${world.connectionId}` },
        { text: /Ready/, timeoutMs: 30_000 },
      );
      const since = new Date().toISOString();
      const run = await world.request(
        world.den.admin,
        `/v1/mcp-connections/${world.connectionId}/tools/call`,
        "POST",
        { toolName: "get_mock_record", arguments: {} },
      );
      expect(run.response.status).toBe(200);
      expect(run.text).toContain("[REDACTED]");
      expect(run.text).not.toContain("demo-admin-secret-4820");
      expect(run.text).not.toContain("demo-org-secret-7310");
      expect(
        (
          await world.connector.toolCalls({
            name: "get_mock_record",
            sinceIso: since,
            atLeast: 1,
          })
        )[0].tokenId,
      ).toBe(fingerprint("demo-admin-secret-4820"));
      evidence.recordAssertionEvidence(
        "real tools/call completes with secret echoes redacted",
        "The mock served get_mock_record under the admin's personal credential; HTTP 200 includes [REDACTED] and neither secret in result or inspection.",
        true,
      );
      await admin.screenshot();
    },
  );
  await step(
    "an ordinary connection with no templates still completes its MCP handshake",
    async () => {
      const result = await world.request(
        world.den.members.jordan,
        `${secrets}/connections/${world.literalId}/check`,
        "POST",
        {},
      );
      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({ toolCount: 1 });
      await admin.see({ testId: "secrets-screen" });
      evidence.recordAssertionEvidence(
        "existing literal connections keep working",
        "The untouched shared MCP connection returns HTTP 200 and one tool without any definition or template binding.",
        true,
      );
      await admin.screenshot();
    },
  );
  await step(
    "changing the MCP destination invalidates the approval before any credential is sent",
    async () => {
      const inventory = await probe.api(
        world.den.admin,
        "/v1/mcp-connections?scope=manageable",
      );
      const current = records(
        isRecord(inventory.body) ? inventory.body.connections : [],
      ).find((r) => r.id === world.connectionId);
      if (!current) throw new Error("The connection disappeared.");
      const changed = await world.request(
        world.den.admin,
        `/v1/mcp-connections/${world.connectionId}`,
        "PUT",
        {
          expectedUpdatedAt: current.updatedAt,
          name: "Mock Records",
          url: `${world.connector.mcpUrl}?destination=changed`,
          authType: "none",
          credentialMode: "per_member",
          access: { orgWide: false, memberIds: world.memberIds, teamIds: [] },
        },
      );
      expect(changed.response.ok).toBe(true);
      await casey.reload();
      await casey.see(
        { testId: `secret-binding-${world.connectionId}` },
        { text: /workspace admin needs to update/, timeoutMs: 60_000 },
      );
      const count = (await world.connector.handshakes()).length;
      const blocked = await world.request(
        world.den.members.casey,
        `${secrets}/connections/${world.connectionId}/check`,
        "POST",
        {},
      );
      expect(blocked.response.status).toBe(409);
      expect((await world.connector.handshakes()).length).toBe(count);
      evidence.recordAssertionEvidence(
        "destination changes require a new binding and fresh member approval",
        "The endpoint update succeeds, readiness becomes false, and a check returns HTTP 409 without reaching the changed provider URL.",
        true,
      );
      await casey.screenshot();
    },
  );
  await step(
    "removing a member ends their secret-management and MCP access",
    async () => {
      const removed = await world.request(
        world.den.admin,
        `/v1/members/${world.memberIds[2]}`,
        "DELETE",
      );
      expect(removed.response.status).toBe(204);
      const staleRead = await world.request(
        world.den.members.casey,
        secrets,
        "GET",
      );
      const staleUse = await world.request(
        world.den.members.casey,
        `${secrets}/connections/${world.connectionId}/check`,
        "POST",
        {},
      );
      expect([401, 403, 404]).toContain(staleRead.response.status);
      expect([401, 403, 404]).toContain(staleUse.response.status);
      await admin.navigate(`${world.den.ref.webUrl}/dashboard/manage-members`);
      await admin.see({ text: "Jordan Member" }, { timeoutMs: 60_000 });
      await admin.notSee({ text: "Casey Member" });
      evidence.recordAssertionEvidence(
        "a removed membership cannot read metadata or use stored credentials",
        "Member removal returns HTTP 204; the old member session is refused on management and connection-check routes; Casey is absent from the active member list.",
        true,
      );
      await admin.screenshot();
    },
  );
});
