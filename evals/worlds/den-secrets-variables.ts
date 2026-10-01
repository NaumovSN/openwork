import { denFetch, type DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isRecord, records, stringField } from "./library.ts";

/** Real Den, independent browser sessions, and a deterministic HTTP MCP. All credentials are synthetic. */
export async function denSecretsVariables(seed: Seed) {
  const den = await seed.den({
    org: {
      name: `Secrets Preview ${Date.now()}`,
      admin: { name: "Alex Admin" },
      members: {
        jordan: { name: "Jordan Member" },
        casey: { name: "Casey Member" },
        denied: { name: "Morgan Without Access" },
      },
    },
    mocks: {
      connector: seed.mock({
        allowUnauthenticatedMcp: true,
        witnessHeaders: ["x-workspace", "x-organization-key"],
        tools: [
          {
            name: "get_mock_record",
            description: "Read a synthetic record",
            inputSchema: { type: "object", properties: {} },
            result: {
              content: [
                {
                  type: "text",
                  text: "Mock record retrieved. Provider echo: demo-admin-secret-4820 / demo-org-secret-7310",
                },
              ],
            },
          },
        ],
      }),
    },
  });
  const org = await seed.api(den.admin, "/v1/org");
  const memberRows = isRecord(org.body) ? records(org.body.members) : [];
  const memberIds = ["Alex Admin", "Jordan Member", "Casey Member"].map(
    (name) => {
      const row = memberRows.find(
        (member) => isRecord(member.user) && member.user.name === name,
      );
      if (!row) throw new Error(`Could not find ${name}.`);
      return String(row.id);
    },
  );
  const created = await seed.api(den.admin, "/v1/mcp-connections", {
    method: "POST",
    body: JSON.stringify({
      name: "Mock Records",
      url: den.mocks.connector.mcpUrl,
      authType: "none",
      credentialMode: "per_member",
      access: { orgWide: false, memberIds, teamIds: [] },
    }),
  });
  const connectionId = stringField(created.body, "id");
  if (!created.response.ok || !connectionId)
    throw new Error(
      `Mock connection setup failed: ${created.response.status} ${created.text.slice(0, 200)}`,
    );
  const literal = await seed.api(den.admin, "/v1/mcp-connections", {
    method: "POST",
    body: JSON.stringify({
      name: "Literal Mock",
      url: `${den.mocks.connector.mcpUrl}?literal=1`,
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  const literalId = stringField(literal.body, "id");
  if (!literal.response.ok || !literalId)
    throw new Error("Could not seed the ordinary MCP connection.");
  const issued = await seed.api(den.members.jordan, "/v1/mcp/token", {
    method: "POST",
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const mcpToken = stringField(issued.body, "token");
  if (!issued.response.ok || !mcpToken)
    throw new Error("Could not issue the member's real MCP credential.");
  const viewport = { width: 1440, height: 1100 };
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/secrets",
    headless: true,
    viewport,
  });
  const memberWeb = await seed.web({
    den,
    signedInAs: den.members.jordan,
    startPath: "/dashboard/secrets",
    headless: true,
    viewport,
  });
  const caseyWeb = await seed.web({
    den,
    signedInAs: den.members.casey,
    startPath: "/dashboard/secrets",
    headless: true,
    viewport,
  });
  const deniedWeb = await seed.web({
    den,
    signedInAs: den.members.denied,
    startPath: "/dashboard/secrets",
    headless: true,
    viewport,
  });
  return {
    den,
    web,
    memberWeb,
    caseyWeb,
    deniedWeb,
    connectionId,
    literalId,
    memberIds,
    connector: den.mocks.connector,
    async callAsJordan() {
      return denFetch(den.ref, `/mcp/agent/connections/${connectionId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${mcpToken}`,
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_mock_record", arguments: {} },
        }),
      });
    },
    async request(
      session: DenSession,
      path: string,
      method: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) {
      return denFetch(session, path, {
        method,
        headers: { authorization: `Bearer ${session.token}`, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}
