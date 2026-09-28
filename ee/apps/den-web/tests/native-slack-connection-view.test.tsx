import { afterAll, expect, mock, spyOn, test } from "bun:test";
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
const { AdminConnectorsScreen } = await import("../app/(den)/dashboard/_components/admin-connectors-screen");
const { YourConnectionsScreen } = await import("../app/(den)/dashboard/_components/your-connections-screen");
const { LibraryScreen } = await import("../app/(den)/dashboard/_components/library-screen");
const { libraryModelQueryKeys } = await import("../app/(den)/dashboard/_components/library-models-data");
const { pluginQueryKeys } = await import("../app/(den)/dashboard/_components/plugin-data");
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

const policyMessage = "An OpenWork administrator must enable Slack before you can use this account.";
const blockedSlack = { ...slack, connected: false, missingFeatures: [], policyBlocked: true, policyMessage };

function render(connection: ExternalMcpConnection | null, view: "member" | "admin" | "your" | "library" | "manage" = "member") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(mcpConnectionQueryKeys.list("org-synthetic", "usable"), connection ? [connection] : []);
  client.setQueryData(mcpConnectionQueryKeys.list("org-synthetic", "manageable"), []);
  client.setQueryData(mcpConnectionQueryKeys.tools("org-synthetic", "slack"), { tools: [] });
  client.setQueryData(libraryQueryKeys.items, []);
  client.setQueryData(mcpConnectionQueryKeys.presets(), []);
  client.setQueryData(libraryModelQueryKeys.providers("org-synthetic"), []);
  client.setQueryData(libraryModelQueryKeys.connections("org-synthetic"), []);
  client.setQueryData(pluginQueryKeys.summaries(), []);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <DenToastProvider>
          {view === "library" ? <LibraryScreen /> : view === "manage" ? <AdminConnectorsScreen /> : view === "your" ? <YourConnectionsScreen /> : view === "admin" && connection ? <AdminConnectorPageScreen connection={connection} /> : <LibraryConnectorScreen connectionId="slack" />}
        </DenToastProvider>
      </QueryClientProvider>,
    );
  } finally { client.clear(); }
}

test("member Slack page shows usable limited access and optional Reconnect without raw identity", () => {
  const html = render(slack);
  expect(html).toContain("Connected with limited access");
  expect(html).toContain("Limited permissions for: private channels, direct messages, group direct messages");
  expect(html).toContain("Reconnect</div></button>");
  expect(html).not.toContain(slack.externalAccountId);
  expect(html).not.toContain("Client ID");
  expect(html).toContain('/integrations/slack.svg');
});

test("private search granted without private history never labels the whole category unauthorized or unsearched", () => {
  const connection: ExternalMcpConnection = {
    ...slack,
    missingFeatures: ["privateChannels"],
    grantedScopes: [
      "search:read.public", "channels:history", "search:read.private",
      "search:read.im", "im:history", "search:read.mpim", "mpim:history",
    ],
  };
  const views: Array<"member" | "admin" | "your"> = ["member", "admin", "your"];
  for (const view of views) {
    const html = render(connection, view);
    expect(html).toContain("Connected with limited access");
    expect(html).toContain("Limited permissions for: private channels");
    expect(html).not.toContain("Not authorized");
    expect(html.toLowerCase()).not.toContain("unsearched");
    expect(html).not.toContain("Reconnect required");
  }
});

test("required Slack access still asks the member to reconnect", () => {
  const html = render({ ...slack, needsReconnect: true });
  expect(html).toContain("Reconnect</div></button>");
  expect(html).not.toContain("Connected with limited access");
  expect(html).not.toContain(slack.externalAccountId);
});

test("native Slack admin page has no app-creation or connection-deletion controls", () => {
  const html = render(slack, "admin");
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
  const html = render({ ...slack, tenantId: "workspace-synthetic" }, "your");
  expect(html).toContain("Connected with limited access");
  expect(html).toContain("Limited permissions for: private channels, direct messages, group direct messages");
  expect(html).toContain('data-testid="connect-my-mcp-account-slack"');
  expect(html).toContain('data-testid="disconnect-my-mcp-account-slack"');
  expect(html).not.toContain("Reconnect required");
  expect(html).not.toContain("workspace-synthetic");
  expect(html).not.toContain("Client ID");
});

test("blocked member and admin pages retain Disconnect, show the policy owner, and have no executable Chat or sign-in", async () => {
  const requests = await import("../app/(den)/_lib/den-flow");
  const { mcpConnectionsQueryOptions } = await import("../app/(den)/dashboard/_components/mcp-connections-data");
  const payload = { connections: [blockedSlack] };
  const request = spyOn(requests, "requestJson").mockImplementation(async () => ({ response: Response.json(payload), payload, text: JSON.stringify(payload) }));
  const client = new QueryClient();
  let connection: ExternalMcpConnection | undefined;
  try {
    [connection] = await client.fetchQuery(mcpConnectionsQueryOptions("org-synthetic", "usable"));
  } finally { client.clear(); request.mockRestore(); }
  if (!connection) throw new Error("The stored Slack account was omitted");
  for (const admin of [false, true]) {
    const html = render(connection, admin ? "admin" : "member");
    expect(html).toContain("Blocked");
    expect(html).toContain("lucide-lock");
    expect(html).toContain(policyMessage);
    expect(html).toContain("Disconnect</div></button>");
    expect(html).not.toContain("openwork://chat");
    expect(html).not.toContain("Sign in</div></button>");
    expect(html).not.toContain("Reconnect</div></button>");
    expect(html).not.toContain("Connected with limited access");
  }
});

test("Your Connections keeps a blocked account manageable, not connected or reconnectable", () => {
  const html = render(blockedSlack, "your");
  expect(html).toContain("Blocked");
  expect(html).toContain("lucide-lock");
  expect(html).toContain(policyMessage);
  expect(html).toContain('data-testid="disconnect-my-mcp-account-slack"');
  expect(html).not.toContain('data-testid="connect-my-mcp-account-slack"');
  expect(html).not.toContain("Connected as you");
  expect(html).not.toContain("Reconnect required");
});

test("Library retains only the server-supplied blocked account even when the capability-backed Library omits it", () => {
  const html = render(blockedSlack, "library");
  expect(html).toContain('data-library-item="Slack"');
  expect(html).toContain("Blocked");
  expect(html).toContain("lucide-lock");
  expect(html).toContain(policyMessage);
  expect(html).toContain('/dashboard/library/connectors/slack');
  expect(html).not.toContain("Sign in</div></button>");
  expect(render(null, "library")).not.toContain('data-library-item="Slack"');
});

test("the admin list shows blocked account management, not unfinished app setup", () => {
  const html = render(blockedSlack, "manage");
  expect(html).toContain('data-connector-row="Slack"');
  expect(html).toContain("Blocked");
  expect(html).toContain("lucide-lock");
  expect(html).toContain(policyMessage);
  expect(html).not.toContain("Setup not finished");
});

test("Disconnect on the blocked Your Connections row calls only account removal and clears that row", async () => {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register({ url: "https://app.example.test/dashboard/your-connections" });
  const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const requests = await import("../app/(den)/_lib/den-flow");
  const calls: string[] = [];
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const payload = path === "/v1/oauth-providers/slack/disconnect" ? { ok: true } : { connections: [] };
    return { response: Response.json(payload), payload, text: JSON.stringify(payload) };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(mcpConnectionQueryKeys.list("org-synthetic", "usable"), [blockedSlack]);
  client.setQueryData(mcpConnectionQueryKeys.presets(), []);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><YourConnectionsScreen /></QueryClientProvider>));
    expect(host.textContent).toContain("Blocked");
    expect(host.querySelector('[data-testid="connect-my-mcp-account-slack"]')).toBeNull();
    const disconnect = host.querySelector<HTMLButtonElement>('[data-testid="disconnect-my-mcp-account-slack"]');
    if (!disconnect) throw new Error("Missing Disconnect action for the blocked account");
    expect(disconnect.disabled).toBe(false);
    await act(async () => disconnect.click());
    expect(calls).toContain("POST /v1/oauth-providers/slack/disconnect");
    expect(calls.some((call) => call.includes("/connect/start"))).toBe(false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector('[data-testid="disconnect-my-mcp-account-slack"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    request.mockRestore();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    await GlobalRegistrator.unregister();
  }
});
