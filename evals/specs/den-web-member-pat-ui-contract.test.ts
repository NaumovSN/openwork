import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  MEMBER_API_KEY_GRANT_HELP,
  MEMBER_API_KEY_MAX_LENGTH,
  credentialModeForAuth,
  memberApiKeyFailureMessage,
  memberApiKeyRequest,
  personalApiKeyStatus,
  personalApiKeyStatusLabel,
  usesMemberApiKey,
  validateMemberApiKey,
} from "../../ee/apps/den-web/app/(den)/dashboard/_components/member-api-key.ts";

const componentUrl = (name: string) => new URL(`../../ee/apps/den-web/app/(den)/dashboard/_components/${name}`, import.meta.url);
const source = (name: string) => readFile(fileURLToPath(componentUrl(name)), "utf8");

test("Den web keeps a member API key raw, bounded, and out of URLs and authorization headers", async ({ evidence }) => {
  const apiKey = "pat_ABC-123.!~";
  expect(validateMemberApiKey(apiKey)).toBeNull();
  for (const invalid of ["", "has space", "has\ttab", "has\nline", "café", "\u007f"]) {
    expect(validateMemberApiKey(invalid), JSON.stringify(invalid)).not.toBeNull();
  }
  expect(validateMemberApiKey("a".repeat(MEMBER_API_KEY_MAX_LENGTH))).toBeNull();
  expect(validateMemberApiKey("a".repeat(MEMBER_API_KEY_MAX_LENGTH + 1))).toBe("The key is too long.");

  const request = memberApiKeyRequest("connection/one", "org_fixture", apiKey);
  expect(request.path).toBe("/v1/mcp-connections/connection%2Fone/member-api-key");
  expect(request.path).not.toContain(apiKey);
  expect(request.init).toMatchObject({ method: "POST", headers: { "x-openwork-org-id": "org_fixture" } });
  expect(JSON.parse(String(request.init.body))).toEqual({ apiKey });
  expect(JSON.stringify(request.init.headers)).not.toContain(apiKey);
  expect(JSON.stringify(request.init.headers)).not.toContain("Bearer");

  evidence.recordAssertionEvidence(
    "Member API keys are sent once as an unchanged JSON value",
    "Printable ASCII up to 8192 characters is accepted; whitespace, controls, non-ASCII, URL placement, and Authorization-header placement are rejected by the client contract.",
    true,
  );
});

test("Den web renders a private member-key dialog and only exposes generic failures", async ({ evidence }) => {
  const secret = "provider-echoed-private-key";
  for (const status of [400, 403, 404, 409, 500, undefined]) {
    expect(memberApiKeyFailureMessage(status)).not.toContain(secret);
  }
  expect(memberApiKeyFailureMessage(403)).toBe(MEMBER_API_KEY_GRANT_HELP);
  expect(MEMBER_API_KEY_GRANT_HELP).toBe("You can't add a key to this connection yet. Ask an administrator to give you access directly, through your team, or for everyone.");

  const dialog = await source("member-api-key-dialog.tsx");
  expect(dialog).toContain("{MEMBER_API_KEY_DIALOG_SUBTITLE}");
  expect(dialog).not.toContain("{MEMBER_API_KEY_GRANT_HELP}");
  const data = await source("mcp-connections-data.tsx");
  const saveHook = data.slice(data.indexOf("export function useSaveMyMcpApiKey"), data.indexOf("export function useDisconnectMyProviderAccount"));
  expect(dialog).toContain('kind="secret"');
  expect(dialog).toContain('aria-label={`${target?.name ?? "Connection"} key`}');
  expect(dialog).toContain('autoComplete="off"');
  expect(dialog).toContain("data-ph-no-capture");
  expect(dialog).toContain("maxLength={MEMBER_API_KEY_MAX_LENGTH}");
  expect(dialog).toContain('setApiKey("")');
  expect(dialog).toContain(": key saved`");
  expect(dialog).not.toContain("not verified");
  expect(dialog).toContain("<Dialog.Title");
  expect(dialog).toContain("<Dialog.Description");
  expect(dialog).toContain("memberApiKeySaveErrorMessage(cause)");
  expect(dialog).not.toContain("cause.message");
  expect(dialog.indexOf("setSaved(true)")).toBeLessThan(dialog.indexOf("await onSaved?.()"));
  expect(dialog).not.toMatch(/URLSearchParams|localStorage|posthog|console\./);
  expect(saveHook).not.toContain("useMutation");
  expect(saveHook).not.toContain("getRequestError");
  expect(saveHook).not.toContain("cause.message");

  evidence.recordAssertionEvidence(
    "The token dialog does not persist, prefill, read back, or report member secrets",
    "Password input is labeled, autocomplete-off, analytics-excluded, cleared on submit/cancel/target change, and the non-mutation-cache request maps failures without server text.",
    true,
  );
});

test("Den web routes only individual API-key connections to the token dialog and creates one central connection", async ({ evidence }) => {
  expect(usesMemberApiKey({ authType: "apikey", credentialMode: "per_member" })).toBe(true);
  expect(usesMemberApiKey({ authType: "apikey", credentialMode: "shared" })).toBe(false);
  expect(usesMemberApiKey({ authType: "oauth", credentialMode: "per_member" })).toBe(false);
  expect(credentialModeForAuth("none", "per_member")).toBe("shared");
  expect(credentialModeForAuth("apikey", "per_member")).toBe("per_member");
  expect(personalApiKeyStatus({ authType: "apikey", credentialMode: "per_member", connectedForMe: false, credentialHealth: "unknown" })).toBe("missing");
  expect(personalApiKeyStatus({ authType: "apikey", credentialMode: "per_member", connectedForMe: true, credentialHealth: "unknown" })).toBe("saved_unverified");
  expect(personalApiKeyStatus({ authType: "apikey", credentialMode: "per_member", connectedForMe: true })).toBe("saved_unverified");
  expect(personalApiKeyStatus({ authType: "apikey", credentialMode: "per_member", connectedForMe: true, credentialHealth: "ready" })).toBe("ready");
  expect(personalApiKeyStatus({ authType: "apikey", credentialMode: "per_member", connectedForMe: true, credentialHealth: "reconnect_required", needsReconnect: true })).toBe("reconnect_required");
  expect(personalApiKeyStatusLabel("saved_unverified")).toBe("Key saved");
  expect(personalApiKeyStatusLabel("reconnect_required")).toBe("Replace key");

  const [yourConnections, libraryDetail, setup, setupFields, adminSetup, settings, connectorDetail, toolTester, data] = await Promise.all([
    source("your-connections-screen.tsx"),
    source("connector-page-screen.tsx"),
    source("connector-setup.ts"),
    source("connector-setup-fields.tsx"),
    source("admin-connector-setup-screen.tsx"),
    source("connector-settings.tsx"),
    source("connector-detail.ts"),
    source("tool-tester/tool-tester-screen.tsx"),
    source("mcp-connections-data.tsx"),
  ]);
  expect(yourConnections).toContain("usesMemberApiKey(connection)");
  expect(yourConnections).toContain("<MemberApiKeyDialog");
  expect(libraryDetail).toContain("<MemberApiKeyDialog");
  expect(setup).toContain('createForMe({ authType: "apikey", credentialMode: "per_member", apiKeyAuthScheme })');
  expect(setup).toContain("signedIn && !usesIndividualKeys");
  expect(setup).toContain("const key = apiKey.trim()");
  expect(setup).toContain("Key added. Everyone uses it.");
  expect(setup).not.toContain("Organization key saved, not verified");
  expect(setupFields).not.toContain("MEMBER_API_KEY_MAX_LENGTH");
  expect(settings).toContain('const usesSharedKey = usesKey && chosenMode === "shared"');
  expect(settings).toContain('const usesPersonalKey = usesKey && chosenMode === "per_member"');
  expect(settings).toContain("const normalizedApiKey = apiKey.trim()");
  expect(settings).not.toContain("validateMemberApiKey");
  expect(settings).not.toContain("MEMBER_API_KEY_MAX_LENGTH");
  expect(settings).toContain("credentialModeForAuth(authType, credentialMode)");
  expect(adminSetup).toContain("usesIndividualKeys ? `${name} is ready`");
  expect(adminSetup).toContain('"Each person can now add their own key in My Library."');
  expect(adminSetup).not.toContain("not verified");
  expect(libraryDetail).toContain('connection.authType === "apikey" ? "Organization key ready"');
  expect(yourConnections).toContain('apiKeyStatus === "reconnect_required" ? "Replace key"');
  expect(libraryDetail).toContain('apiKeyStatus === "reconnect_required"');
  expect(connectorDetail).toContain("personalApiKeyStatusLabel(apiKeyStatus)");
  expect(toolTester).toContain("personalApiKeyStatusLabel");
  const saveHook = data.slice(data.indexOf("export function useSaveMyMcpApiKey"), data.indexOf("export function useDisconnectMyProviderAccount"));
  const runToolHook = data.slice(data.indexOf("export function useRunMcpConnectionTool"), data.indexOf("function isRecord"));
  expect(saveHook).not.toContain("payload.ok");
  expect(runToolHook).toContain("queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all })");
  expect(runToolHook).toContain("queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items })");

  evidence.recordAssertionEvidence(
    "Member PAT and admin credential-mode paths stay distinct",
    "HTTP 200 is treated as stored rather than provider-validated; unknown health stays saved/unverified, ready is explicit, rejection requests replacement, no-auth stays shared, and admin individual mode creates one keyless central connection.",
    true,
  );
});
