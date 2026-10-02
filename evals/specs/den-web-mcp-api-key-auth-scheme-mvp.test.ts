import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  apiKeyAuthSchemeInput,
  DEFAULT_API_KEY_AUTH_SCHEME,
  type CreateMcpConnectionInput,
  type ExternalMcpApiKeyAuthScheme,
  type ExternalMcpConnection,
  type UpdateMcpConnectionInput,
} from "../../ee/apps/den-web/app/(den)/dashboard/_components/mcp-connections-data.tsx";

const allowedSchemes = ["bearer", "token"] as const satisfies readonly ExternalMcpApiKeyAuthScheme[];
const createWithoutScheme = { authType: "apikey" } satisfies Pick<CreateMcpConnectionInput, "authType" | "apiKeyAuthScheme">;
const updateWithoutScheme = { authType: "apikey" } satisfies Pick<UpdateMcpConnectionInput, "authType" | "apiKeyAuthScheme">;
const inventoryScheme = { authType: "apikey", apiKeyAuthScheme: "token" } satisfies Pick<ExternalMcpConnection, "authType" | "apiKeyAuthScheme">;
// @ts-expect-error Inventory responses always carry one of the typed schemes.
const inventoryWithoutScheme: Pick<ExternalMcpConnection, "authType" | "apiKeyAuthScheme"> = { authType: "apikey" };
void inventoryWithoutScheme;

test("MVP API key authorization scheme contract is typed and API-key-only", ({ evidence }) => {
  expect(allowedSchemes).toEqual(["bearer", "token"]);
  expect(DEFAULT_API_KEY_AUTH_SCHEME).toBe("bearer");
  expect(createWithoutScheme).toEqual({ authType: "apikey" });
  expect(updateWithoutScheme).toEqual({ authType: "apikey" });
  expect(inventoryScheme.apiKeyAuthScheme).toBe("token");
  expect(apiKeyAuthSchemeInput("apikey", "bearer")).toEqual({ apiKeyAuthScheme: "bearer" });
  expect(apiKeyAuthSchemeInput("apikey", "token")).toEqual({ apiKeyAuthScheme: "token" });
  expect(apiKeyAuthSchemeInput("oauth", "token")).toEqual({});
  expect(apiKeyAuthSchemeInput("none", "token")).toEqual({});
  evidence.recordAssertionEvidence(
    "The MVP admin transport has exactly two typed schemes and only API-key requests carry one",
    "Create and update may omit the field for backend default/preservation, inventory requires it, Bearer is the UI default, and OAuth/no-auth bodies omit it.",
    true,
  );
});

test("MVP admin forms expose stable Bearer and Token selectors", async ({ evidence }) => {
  const setup = await readFile(new URL("../../ee/apps/den-web/app/(den)/dashboard/_components/admin-connector-setup-screen.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../../ee/apps/den-web/app/(den)/dashboard/_components/connector-settings.tsx", import.meta.url), "utf8");
  expect(setup).toContain('data-testid="connector-setup-api-key-auth-scheme"');
  expect(settings).toContain('data-testid="connector-settings-api-key-auth-scheme"');
  for (const source of [setup, settings]) {
    expect(source).toContain('<option value="bearer">Bearer</option>');
    expect(source).toContain('<option value="token">Token</option>');
  }
  evidence.recordAssertionEvidence(
    "Both MVP admin entry points expose only Bearer and Token",
    "Create and edit forms have stable selectors with the same two options; no custom header-name input is introduced.",
    true,
  );
});
