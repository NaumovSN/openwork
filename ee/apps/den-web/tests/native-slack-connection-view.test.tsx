import { afterAll, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExternalMcpConnection } from "../app/(den)/dashboard/_components/mcp-connections-data";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
mock.module("../app/(den)/dashboard/_providers/org-dashboard-provider", () => ({
  useOrgDashboard: () => ({ orgId: "org-synthetic", orgSlug: "workspace", orgContext: null }),
}));
mock.module("../app/(den)/_providers/den-flow-provider", () => ({
  useDenFlow: () => ({ runtimeConfigLoaded: false, runtimeConfig: {} }),
}));
const { LibraryConnectorScreen } = await import("../app/(den)/dashboard/_components/connector-page-screen");
const { AdminConnectorPageScreen } = await import("../app/(den)/dashboard/_components/admin-connector-page-screen");
const { YourConnectionsScreen } = await import("../app/(den)/dashboard/_components/your-connections-screen");
const { DenToastProvider } = await import("../app/(den)/dashboard/_components/den-toast");
const { libraryQueryKeys } = await import("../app/(den)/dashboard/_components/library-data");
const { mcpConnectionQueryKeys } = await import("../app/(den)/dashboard/_components/mcp-connections-data");

afterAll(() => mock.restore());
const slack: ExternalMcpConnection = {
  id: "slack", name: "Slack", nativeProviderKey: "slack", url: "https://slack.com/api",
  authType: "oauth", credentialMode: "per_member", exposeDirectly: false,
  connected: true, connectedForMe: true, connectedAt: "2026-09-01T00:00:00.000Z", updatedAt: null,
  externalAccountId: "slack:workspace-synthetic:user-synthetic",
  needsReconnect: false, missingFeatures: ["privateChannels", "directMessages", "groupMessages"],
  requiredBy: [], identityManagedBy: [], access: null,
};

function render(connection: ExternalMcpConnection | null, admin = false, yourConnections = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(mcpConnectionQueryKeys.list("org-synthetic", "usable"), connection ? [connection] : []);
  client.setQueryData(mcpConnectionQueryKeys.tools("org-synthetic", "slack"), { tools: [] });
  client.setQueryData(libraryQueryKeys.items, []);
  client.setQueryData(mcpConnectionQueryKeys.presets(), []);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <DenToastProvider>
          {yourConnections ? <YourConnectionsScreen /> : admin && connection ? <AdminConnectorPageScreen connection={connection} /> : <LibraryConnectorScreen connectionId="slack" />}
        </DenToastProvider>
      </QueryClientProvider>,
    );
  } finally { client.clear(); }
}

test("member Slack page shows usable limited access and optional Reconnect without raw identity", () => {
  const html = render(slack);
  expect(html).toContain("Connected with limited access");
  expect(html).toContain("Not authorized: private channels, direct messages, group direct messages");
  expect(html).toContain("Reconnect</div></button>");
  expect(html).not.toContain(slack.externalAccountId);
  expect(html).not.toContain("Client ID");
  expect(html).toContain('/integrations/slack.svg');
});

test("required Slack access still asks the member to reconnect", () => {
  const html = render({ ...slack, needsReconnect: true });
  expect(html).toContain("Reconnect</div></button>");
  expect(html).not.toContain("Connected with limited access");
  expect(html).not.toContain(slack.externalAccountId);
});

test("native Slack admin page has no app-creation or connection-deletion controls", () => {
  const html = render(slack, true);
  expect(html).not.toContain("Edit settings");
  expect(html).not.toContain("connector-settings-toggle");
  expect(html).not.toContain("Client ID");
  expect(html).not.toContain("Remove Slack");
  expect(html).not.toContain(slack.externalAccountId);
  expect(html).toContain("Connected with limited access");
});

test("no synthetic Slack entry means no member connection page", () => {
  const html = render(null);
  expect(html).toContain("Not in your Library");
  expect(html).not.toContain("Reconnect</div></button>");
});

test("Your Connections keeps limited Slack usable with Reconnect and Disconnect, without encoded account or tenant IDs", () => {
  const html = render({ ...slack, tenantId: "workspace-synthetic" }, false, true);
  expect(html).toContain("Connected with limited access");
  expect(html).toContain("Not authorized: private channels, direct messages, group direct messages");
  expect(html).toContain('data-testid="connect-my-mcp-account-slack"');
  expect(html).toContain('data-testid="disconnect-my-mcp-account-slack"');
  expect(html).not.toContain("Reconnect required");
  expect(html).not.toContain("workspace-synthetic");
  expect(html).not.toContain("Client ID");
});
