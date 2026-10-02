import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiSettingsViewProps } from "../src/react-app/domains/settings/pages/ai-view";
const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { AiSettingsView } = await import("../src/react-app/domains/settings/pages/ai-view");
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

const props: AiSettingsViewProps = {
  busy: false, providerAuthBusy: false, providerStatusLabel: "Connected", providerStatusStyle: "", providerSummary: "2 providers", providerLoadState: { status: "ready", error: null }, onRetryProviders: () => {},
  connectedProviders: [{ id: "anthropic", name: "Anthropic", source: "api" }, { id: "ipr_fixture", name: "Organization OpenAI" }], cloudProviderIds: new Set(["ipr_fixture"]), organizationName: "Example Team",
  disconnectingProviderId: null, providerConnectError: null, providerDisconnectStatus: null, providerDisconnectError: null, onOpenProviderAuth: () => {}, onDisconnectProvider: () => {}, canDisconnectProvider: () => true, canAddProviders: true,
};

test("device and organization providers have distinct ownership without invented audience or timestamps", () => {
  const html = renderToStaticMarkup(<AiSettingsView {...props} />);
  expect(html).toContain("On this device"); expect(html).toContain("From Example Team");
  expect(html.match(/data-provider-scope="device"/g)).toHaveLength(1);
  expect(html).toContain("Managed in Den");
  expect(html).not.toContain("Everyone"); expect(html).not.toContain("Added today");
});

test("Auto off remains visible with a real re-enable action and no readiness claim", () => {
  const html = renderToStaticMarkup(<AiSettingsView {...props} autoPreferences={{ enabled: false, available: false, canEnable: true }} onSetAutoEnabled={() => {}} />);
  const auto = html.slice(html.indexOf('data-testid="settings-auto-provider"'), html.indexOf('data-provider-scope="device"', html.indexOf('data-testid="settings-auto-provider"') + 60));
  expect(auto).toContain("OpenWork Models"); expect(auto).toContain("Turned off"); expect(auto).toContain("Turn on"); expect(auto).not.toContain("Ready to use");
});

test("built-in Zen without a key is not listed as a connected device provider", () => {
  const html = renderToStaticMarkup(<AiSettingsView {...props} connectedProviders={[...props.connectedProviders, { id: "opencode", name: "OpenCode Zen", source: "custom" }]} />);
  expect(html).not.toContain("OpenCode Zen");
  const keyed = renderToStaticMarkup(<AiSettingsView {...props} connectedProviders={[...props.connectedProviders, { id: "opencode", name: "OpenCode Zen", source: "api" }]} />);
  expect(keyed).toContain("OpenCode Zen");
});

test("policy-blocked connect remains visible with its owner and cold load uses a skeleton", () => {
  const blocked = renderToStaticMarkup(<AiSettingsView {...props} canAddProviders={false} />);
  expect(blocked).toContain("Connect a provider"); expect(blocked).toContain("organization administrator"); expect(blocked).toContain('disabled=""');
  const pending = renderToStaticMarkup(<AiSettingsView {...props} connectedProviders={[]} providerLoadState={{ status: "loading", error: null }} />);
  expect(pending).toContain("animate-pulse"); expect(pending).not.toContain("No providers connected yet");
});
