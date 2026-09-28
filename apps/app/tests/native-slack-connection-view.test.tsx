import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { DenExternalMcpConnection } from "../src/app/lib/den";
import type { ExtensionItem } from "../src/react-app/domains/settings/extension-items";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ isSignedIn: false, status: "signed_out", verifiedIdentity: null }),
}));
const { createRoot } = await import("react-dom/client");
const { McpView } = await import("../src/react-app/domains/settings/pages/mcp-view");
const { CloudSessionProvider } = await import("../src/react-app/domains/settings/cloud/cloud-session-provider");
const { TooltipProvider } = await import("../src/components/ui/tooltip");
const { isOrgMcpConnectionReady, orgMcpConnectionDescription } = await import("../src/react-app/domains/settings/extension-items");

const slack: DenExternalMcpConnection = {
  id: "slack",
  name: "Slack",
  nativeProviderKey: "slack",
  url: "https://slack.com/api",
  authType: "oauth",
  credentialMode: "per_member",
  exposeDirectly: false,
  connected: true,
  connectedForMe: true,
  connectedAt: "2026-09-01T00:00:00.000Z",
  externalAccountId: "slack:workspace-synthetic:user-synthetic",
  needsReconnect: false,
  missingFeatures: ["privateChannels", "directMessages", "groupMessages"],
};
const policyMessage = "An OpenWork administrator must enable Slack before you can use this account.";
const blockedSlack = { ...slack, connected: false, missingFeatures: [], policyBlocked: true, policyMessage };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  window.localStorage.clear();
});
afterAll(async () => {
  mock.restore();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function mount(connection: DenExternalMcpConnection | null, detail = true) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const connect = mock(() => {});
  const reconnect = mock(() => {});
  const disconnect = mock(() => {});
  const items: ExtensionItem[] = connection ? [{
    id: `org-mcp:${connection.id}`,
    source: "org-connection",
    name: connection.name,
    description: orgMcpConnectionDescription(connection),
    installState: "installed",
    setupState: isOrgMcpConnectionReady(connection) ? "ready" : "needs_setup",
    active: isOrgMcpConnectionReady(connection),
    enablement: null,
    resources: [],
    orgMcpConnection: connection,
  }] : [];
  await act(async () => root.render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CloudSessionProvider>
          <TooltipProvider>
            <McpView
              busy={false}
              selectedWorkspaceRoot=""
              isRemoteWorkspace={false}
              mcpServers={[]}
              installedSkills={[]}
              installedCommands={[]}
              installedAgents={[]}
              availableConnectMcpServers={[]}
              installedPlugins={[]}
              mcpStatus={null}
              mcpLastUpdatedAt={null}
              mcpStatuses={{}}
              mcpConnectingName={null}
              allowManageExtensions={false}
              quickConnect={[]}
              connectMcp={async () => ({ ok: true })}
              authorizeMcp={() => {}}
              logoutMcpAuth={() => {}}
              removeMcp={() => {}}
              orgMcpItems={items}
              connectOrgMcp={connect}
              reconnectOrgMcp={reconnect}
              disconnectOrgMcp={disconnect}
              detailId={detail && connection ? `org-mcp:${connection.id}` : null}
              onDetailIdChange={() => {}}
            />
          </TooltipProvider>
        </CloudSessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  ));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    host.remove();
  });
  const button = (label: string) => {
    const match = [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
    if (!match) throw new Error(`Missing ${label} button`);
    return match;
  };
  return { host, button, connect, reconnect, disconnect };
}

test("public-only Slack stays connected, names missing access, and offers optional reconnect", async () => {
  const view = await mount(slack);
  expect(view.host.textContent).toContain("Connected with limited access");
  expect(view.host.textContent).toContain("Limited permissions for: private channels, direct messages, group direct messages");
  expect(view.host.textContent).not.toContain("Reconnect your account to grant newly requested permissions");
  expect(view.host.textContent).not.toContain(slack.externalAccountId);
  expect(view.host.querySelector('img[src$="/ext-slack.svg"]')).not.toBeNull();
  expect(view.host.querySelector("input")).toBeNull();
  await act(async () => view.button("Reconnect").click());
  expect(view.reconnect).toHaveBeenCalledWith("slack");
  expect(view.disconnect).not.toHaveBeenCalled();
  await act(async () => view.button("Disconnect").click());
  expect(view.disconnect).toHaveBeenCalledWith("slack");
});

test("private search granted without private history is limited, not wholly unauthorized or unsearched", async () => {
  const view = await mount({
    ...slack,
    missingFeatures: ["privateChannels"],
    grantedScopes: [
      "search:read.public", "channels:history", "search:read.private",
      "search:read.im", "im:history", "search:read.mpim", "mpim:history",
    ],
  });
  expect(view.host.textContent).toContain("Connected with limited access");
  expect(view.host.textContent).toContain("Limited permissions for: private channels");
  expect(view.host.textContent).not.toContain("Not authorized");
  expect(view.host.textContent?.toLowerCase()).not.toContain("unsearched");
  expect(view.button("Reconnect").disabled).toBe(false);
});

test("missing required Slack public access offers reconnect without a ready label", async () => {
  const view = await mount({ ...slack, needsReconnect: true });
  expect(view.host.textContent).not.toContain("Connected with limited access");
  expect(view.host.textContent).not.toContain("Ready to use");
  await act(async () => view.button("Reconnect").click());
  expect(view.connect).toHaveBeenCalledWith("slack");
});

test("unconnected Slack uses the existing Connect action without app setup", async () => {
  const view = await mount({ ...slack, connected: false, connectedForMe: false, externalAccountId: null, missingFeatures: [] });
  await act(async () => view.button("Connect your account").click());
  expect(view.connect).toHaveBeenCalledWith("slack");
  expect(view.host.textContent).not.toContain("Client ID");
  expect(view.host.textContent).not.toContain("Create app");
  expect(view.host.querySelector("input")).toBeNull();
});

test("full Slack access never prints the encoded account identity", async () => {
  const view = await mount({ ...slack, missingFeatures: [] });
  expect(view.host.textContent).toContain("Connected with your own account");
  expect(view.host.textContent).not.toContain(slack.externalAccountId);
  expect(view.host.textContent).not.toContain("limited access");
});

test("the existing external Slack connection keeps its required reconnect behavior", async () => {
  const view = await mount({ ...slack, id: "external-slack", nativeProviderKey: null, externalAccountId: null, url: "https://mcp.slack.com/mcp" });
  expect(view.host.textContent).toContain("Reconnect your account to grant newly requested permissions");
  await act(async () => view.button("Reconnect").click());
  expect(view.connect).toHaveBeenCalledWith("external-slack");
});

test("the UI does not manufacture a native Slack connection when the server omits it", async () => {
  const view = await mount(null, false);
  expect(view.host.querySelector('[data-library-section="openwork"] [data-library-row="Slack"]')).toBeNull();
  expect(view.connect).not.toHaveBeenCalled();
});

test("a blocked account survives the API parser and keeps Disconnect without authorization or Chat", async () => {
  const { createDenClient } = await import("../src/app/lib/den");
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ connections: [blockedSlack] }));
  let connection: DenExternalMcpConnection | undefined;
  try {
    [connection] = await createDenClient({ baseUrl: "https://api.example.test", token: "synthetic-token" }).listMcpConnections("org-synthetic", "usable");
  } finally { fetch.mockRestore(); }
  if (!connection) throw new Error("The stored Slack account was omitted");
  const view = await mount(connection);
  expect(view.host.textContent).toContain("Blocked");
  expect(view.host.textContent).toContain(policyMessage);
  expect(view.host.querySelector(".lucide-lock") !== null).toBe(true);
  expect(view.button("Chat").disabled).toBe(true);
  await act(async () => view.button("Chat").click());
  expect(view.host.querySelector('[data-extension-detail-page]') !== null).toBe(true);
  expect([...view.host.querySelectorAll("button")].filter((button) => /^(Connect|Reconnect)/.test(button.textContent?.trim() ?? "") && !button.disabled)).toHaveLength(0);
  expect(view.connect).not.toHaveBeenCalled();
  expect(view.reconnect).not.toHaveBeenCalled();
  await act(async () => view.button("Disconnect").click());
  expect(view.disconnect).toHaveBeenCalledWith("slack");
});

test("a blocked account remains an openable Library row, not a ready source", async () => {
  const view = await mount(blockedSlack, false);
  const row = view.host.querySelector<HTMLButtonElement>('[data-library-section="openwork"] [data-library-row="Slack"]');
  expect(row !== null).toBe(true);
  expect(row?.disabled).toBe(false);
  expect(row?.textContent).toContain("Blocked");
  expect(row?.textContent).toContain(policyMessage);
  expect(row?.querySelector(".lucide-lock") !== null).toBe(true);
  expect(row?.querySelector("[data-library-ready]")).toBeNull();
});

test("blocked account lifecycle rejects a stale authorize action but still disconnects through the native API", async () => {
  const den = await import("../src/app/lib/den");
  const { useOrgMcpConnections } = await import("../src/react-app/domains/connections/use-org-mcp-connections");
  const { clearCloudInventoryCache } = await import("../src/react-app/domains/connections/cloud-inventory-cache");
  const { ExtensionDetailModal } = await import("../src/react-app/design-system/extension-detail-modal");
  let accounts: DenExternalMcpConnection[] = [blockedSlack];
  const requests: string[] = [];
  let staleAuthorize = async () => {};
  const settings = spyOn(den, "readDenSettings").mockReturnValue({
    baseUrl: "https://api.example.test", authToken: "synthetic-token", activeOrgId: "org-synthetic",
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/mcp-connections") return Response.json({ connections: accounts });
    if (url.pathname === "/v1/oauth-providers/slack/disconnect") {
      accounts = [];
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  function Account() {
    const connections = useOrgMcpConnections();
    staleAuthorize = () => connections.connect("slack", { forceFreshAuthorization: true });
    const connection = connections.connections[0];
    if (!connection) return null;
    return <ExtensionDetailModal
      open presentation="page" name="Slack" onClose={() => {}}
      description={orgMcpConnectionDescription(connection)}
      disabledReason={connection.policyBlocked ? connection.policyMessage : undefined}
      connected={isOrgMcpConnectionReady(connection)} disconnectedLabel="Blocked"
      uninstallAvailable={connection.connectedForMe}
      onUninstall={() => void connections.disconnect(connection.id)}
      uninstallLabel="Disconnect" closeOnUninstall={false}
    />;
  }
  try {
    clearCloudInventoryCache();
    await act(async () => root.render(<Account />));
    expect(host.textContent).toContain("Blocked");
    await act(staleAuthorize);
    expect(requests.some((request) => request.includes("/connect/start"))).toBe(false);
    const disconnect = [...host.querySelectorAll("button")].find((button) => button.textContent === "Disconnect");
    if (!disconnect) throw new Error("Missing Disconnect action for the blocked account");
    await act(async () => disconnect.click());
    expect(requests).toContain("POST /v1/oauth-providers/slack/disconnect");
    expect(host.textContent).not.toContain("Slack");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    fetch.mockRestore();
    settings.mockRestore();
    clearCloudInventoryCache();
  }
});

test("the composer excludes a blocked account and its stale duplicate, without touching external Slack", async () => {
  const { mergeComposerConnectionInventory } = await import("../src/react-app/domains/session/surface/composer/composer-connections");
  const inventory = mergeComposerConnectionInventory({
    orgConnections: [blockedSlack],
    mcpServers: [
      { name: "slack", orgMcpConnectionId: "slack", config: { type: "remote", url: slack.url } },
      { name: "External Slack", orgMcpConnectionId: "external-slack", config: { type: "remote", url: "https://mcp.slack.com/mcp" } },
    ],
  });
  expect(inventory.servers.map((server) => server.name)).toEqual(["External Slack"]);
});

test("optional Slack reconnect preserves the usable grant on failure; explicit Disconnect uses the native route", async () => {
  const den = await import("../src/app/lib/den");
  const { useOrgMcpConnections } = await import("../src/react-app/domains/connections/use-org-mcp-connections");
  const { clearCloudInventoryCache } = await import("../src/react-app/domains/connections/cloud-inventory-cache");
  const { ExtensionDetailModal } = await import("../src/react-app/design-system/extension-detail-modal");
  const requests: string[] = [];
  let account = slack;
  const settings = spyOn(den, "readDenSettings").mockReturnValue({
    baseUrl: "https://api.example.test", authToken: "synthetic-token", activeOrgId: "org-synthetic",
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/mcp-connections") return Response.json({ connections: [account] });
    if (url.pathname === "/v1/mcp-connections/slack/connect/start") {
      return Response.json({ error: "authorization_failed", message: "Sign-in did not finish. Try again." }, { status: 400 });
    }
    if (url.pathname === "/v1/oauth-providers/slack/disconnect") {
      account = { ...slack, connectedForMe: false, connected: false, externalAccountId: null };
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  function Account() {
    const connections = useOrgMcpConnections();
    const connection = connections.connections[0];
    if (!connection) return null;
    return <ExtensionDetailModal
      open presentation="page" name="Slack" onClose={() => {}}
      description={orgMcpConnectionDescription(connection)}
      connected={isOrgMcpConnectionReady(connection)}
      connectedLabel="Connected with limited access"
      errorInfo={connections.error}
      reconnectLabel="Reconnect"
      onReconnect={() => void connections.connect(connection.id, { forceFreshAuthorization: true })}
      onUninstall={() => void connections.disconnect(connection.id)}
      uninstallLabel="Disconnect" closeOnUninstall={false}
    />;
  }
  const button = (label: string) => {
    const result = [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
    if (!result) throw new Error(`Missing ${label} button`);
    return result;
  };
  try {
    clearCloudInventoryCache();
    await act(async () => root.render(<Account />));
    await act(async () => button("Reconnect").click());
    expect(requests).toContain("GET /v1/mcp-connections/slack/connect/start");
    expect(requests.some((request) => request.includes("disconnect"))).toBe(false);
    expect(host.textContent).toContain("Sign-in did not finish. Try again.");
    expect(host.textContent).toContain("Connected with limited access");
    await act(async () => button("Disconnect").click());
    expect(requests).toContain("POST /v1/oauth-providers/slack/disconnect");
    expect(requests).not.toContain("POST /v1/mcp-connections/slack/disconnect-my-account");
    expect(host.textContent).not.toContain("Connected with limited access");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    fetch.mockRestore();
    settings.mockRestore();
    clearCloudInventoryCache();
  }
});
