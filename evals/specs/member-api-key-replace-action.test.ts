import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { reconnectActionFromChatToolResult } from "../../apps/app/src/components/tools/error-attribution";
import { orgMcpConnectionActionLabel, isOrgMcpConnectionReady } from "../../apps/app/src/react-app/domains/settings/extension-items";

test("only structured member rejection requests replacement in native chat and Library", async ({ evidence }) => {
  const connectionStatus = {
    version: 1, kind: "connection_action", source: "openwork-cloud", connectionId: "member_connection", connectionName: "Private service",
    authType: "apikey", credentialMode: "per_member", state: "reauth_required", actor: "member",
    message: "Replace your own key in Connect. Never paste a key into chat or tool arguments.",
    action: { type: "update_credentials", surface: "openwork_your_connections", retry: "search_capabilities" },
  };
  expect(reconnectActionFromChatToolResult("openwork_execute_capability", { connectionStatus })).toMatchObject({ connectionId: "member_connection", label: "Replace key", credentialKind: "personal_key" });
  const missing = { ...connectionStatus, state: "needs_connection" };
  expect(reconnectActionFromChatToolResult("openwork_execute_capability", { connectionStatus: missing })?.label).toBe("Add key");
  expect(reconnectActionFromChatToolResult("openwork_execute_capability", { connectionStatus: { ...connectionStatus, actor: "organization_admin" } })).toBeNull();
  expect(orgMcpConnectionActionLabel({ authType: "apikey", credentialMode: "per_member", connected: false, connectedForMe: false, needsReconnect: true, missingFeatures: [], externalAccountId: null, credentialHealth: "reconnect_required" })).toBe("Replace key");
  expect(isOrgMcpConnectionReady({ authType: "apikey", credentialMode: "per_member", connected: false, connectedForMe: true, needsReconnect: false, missingFeatures: [], credentialHealth: "reconnect_required" })).toBe(false);
  expect(orgMcpConnectionActionLabel({ authType: "apikey", credentialMode: "per_member", connected: false, connectedForMe: false, needsReconnect: false, missingFeatures: [], externalAccountId: null, credentialHealth: "unknown" })).toBe("Add key");
  expect(orgMcpConnectionActionLabel({ authType: "apikey", credentialMode: "per_member", connected: false, connectedForMe: true, needsReconnect: false, missingFeatures: [], externalAccountId: null, credentialHealth: "unknown" })).toBe("Key saved");
  evidence.recordAssertionEvidence("Replacement action is member-specific and stays outside chat credentials",
    "Native action parsers produce Replace key for structured rejection, Add key for missing credentials, no member action for an admin-owned repair, and Key saved for a stored key. This is UI contract proof, not a live Desktop run.", true);
});
