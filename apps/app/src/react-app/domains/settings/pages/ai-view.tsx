/** @jsxImportSource react */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";
import { LogIn, Sparkles } from "lucide-react";
import { AUTO_PROVIDER_ID } from "../../session/models/model-catalog";

import { t } from "@/i18n";
import {
  gatewayConnectCopy,
  gatewayConnectProviderKey,
  type GatewayConnectProvider,
  isCloudManagedProviderKey,
  OPENWORK_GATEWAY_BADGE_LABEL,
} from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import type { ProviderLoadState } from "../../connections/provider-auth/store";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
};

export type AiSettingsViewProps = {
  busy: boolean;
  providerAuthBusy: boolean;
  providerStatusLabel: string;
  providerStatusStyle: string;
  providerSummary: string;
  providerLoadState: ProviderLoadState;
  onRetryProviders: () => void | Promise<void>;
  connectedProviders: ConnectedProvider[];
  disconnectingProviderId: string | null;
  providerConnectError: string | null;
  providerDisconnectStatus: string | null;
  providerDisconnectError: string | null;
  onOpenProviderAuth: () => void | Promise<void>;
  onDisconnectProvider: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (provider: ConnectedProvider) => boolean;
  canAddProviders: boolean;
  organizationName?: string;
  /** Set of local provider IDs that were imported from cloud. */
  cloudProviderIds?: Set<string>;
  /** Cloud provider IDs routed through the OpenWork inference gateway. */
  gatewayProviderIds?: ReadonlySet<string>;
  /** Gateway providers waiting on this member's own sign-in before they can be used. */
  gatewayConnectProviders?: GatewayConnectProvider[];
  /** Provider whose sign-in is currently open in the browser / being polled. */
  connectingGatewayProviderId?: string | null;
  onConnectGatewayProvider?: (provider: GatewayConnectProvider) => void | Promise<void>;
  showOpenWorkModelsSubscribe?: boolean;
  /** Subtle fallback row when OpenWork Models is not connected and the banner was dismissed. */
  showOpenWorkModelsConnect?: boolean;
  /** Den entitlement is present but local engine has no selectable openwork models yet. */
  showOpenWorkModelsSyncing?: boolean;
  onSubscribeOpenWorkModels?: () => void | Promise<void>;
  onDismissOpenWorkModels?: () => void | Promise<void>;
  cloudProvidersView?: ReactNode;
};

function providerSourceLabel(source?: ConnectedProvider["source"]) {
  if (source === "env") return t("settings.provider_source_env");
  if (source === "api") return t("settings.provider_source_api");
  if (source === "config") return t("settings.provider_source_config");
  if (source === "custom") return t("settings.provider_source_config");
  return null;
}

function providerSourceBadgeClassName(input: { orgManaged: boolean; source?: ConnectedProvider["source"] }) {
  if (input.orgManaged) {
    return "shrink-0 rounded-full border border-blue-6 bg-blue-2 px-2 py-0.5 text-[10px] font-medium text-blue-11";
  }
  if (input.source === "env") {
    return "shrink-0 rounded-full border border-amber-6 bg-amber-2 px-2 py-0.5 text-[10px] font-medium text-amber-11";
  }
  return "shrink-0 rounded-full border border-dls-border bg-dls-sidebar/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground";
}

function providerStatusTone(label: string): "ready" | "warning" | "neutral" {
  if (label.toLowerCase().includes("connected")) return "ready";
  if (label.toLowerCase().includes("error") || label.toLowerCase().includes("fail")) return "warning";
  return "neutral";
}

/** A gateway provider the member must sign in to before its models are usable. */
export function GatewayConnectRow(props: {
  provider: GatewayConnectProvider;
  busy: boolean;
  onConnect?: (provider: GatewayConnectProvider) => void | Promise<void>;
}) {
  const { provider } = props;
  return (
    <LayoutSectionItem
      className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-dls-border px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ProviderIcon providerId={provider.providerId} providerName={provider.name} size={20} className="text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-dls-text">{provider.name}</span>
            <Badge variant="outline" className="h-auto px-2 py-0.5 text-[10px] text-muted-foreground">
              {OPENWORK_GATEWAY_BADGE_LABEL}
            </Badge>
          </div>
          <div className="truncate text-xs text-muted-foreground">{gatewayConnectCopy(provider.name)}</div>
        </div>
      </div>
      <Button
        variant="outline"
        onClick={() => void props.onConnect?.(provider)}
        disabled={props.busy || !props.onConnect}
      >
        <LogIn className="mr-1.5 size-3.5" />
        {props.busy ? "Waiting for sign-in…" : "Connect"}
      </Button>
    </LayoutSectionItem>
  );
}

export function AiSettingsView(props: AiSettingsViewProps) {
  const organizationProviderLabel = props.organizationName?.trim() || t("settings.provider_source_organization");
  const providersReady = props.providerLoadState.status === "ready";
  const providersLoading = props.providerLoadState.status === "loading" || props.providerLoadState.status === "idle";
  const providerLoadError = props.providerLoadState.error;

  return (
    <LayoutStack>
      {/* ---- Providers ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.providers_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.providers_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>
              {providerLoadError
                ? t("providers.load_failed")
                : providersLoading ? t("settings.loading_providers") : props.providerSummary}
              {providersReady ? (
                <SettingsStatusBadge
                  tone={providerStatusTone(props.providerStatusLabel)}
                  label={props.providerStatusLabel}
                />
              ) : null}
            </LayoutSectionItemTitle>
            {props.canAddProviders ? (
              <LayoutSectionItemHeaderActions>
                <Button
                  onClick={() => void props.onOpenProviderAuth()}
                  disabled={props.busy || props.providerAuthBusy || !providersReady}
                >
                  {props.providerAuthBusy
                    ? t("settings.loading_providers")
                    : t("settings.connect_provider")}
                </Button>
              </LayoutSectionItemHeaderActions>
            ) : null}
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {providerLoadError ? (
          <SettingsNotice tone="error" className="flex flex-wrap items-center justify-between gap-3">
            <div role="alert" className="min-w-0 flex-1 space-y-1">
              <p>{providerLoadError}</p>
              {props.connectedProviders.length > 0 ? <p>{t("settings.providers_not_refreshed")}</p> : null}
            </div>
            <Button
              variant="outline"
              onClick={() => void props.onRetryProviders()}
              disabled={props.busy || providersLoading}
              aria-busy={providersLoading}
            >
              {t("settings.providers_retry")}
            </Button>
          </SettingsNotice>
        ) : null}

        {props.connectedProviders.length > 0 ? (
          <div className="space-y-2">
            {props.connectedProviders.map((provider) => {
              const auto = provider.id === AUTO_PROVIDER_ID;
              const orgManaged = isCloudManagedProviderKey(provider.id);
              const managedByCloud = auto || orgManaged || props.cloudProviderIds?.has(provider.id) === true;
              const sourceLabel = orgManaged
                ? organizationProviderLabel
                : providerSourceLabel(provider.source);
              return (
                <LayoutSectionItem
                  key={provider.id}
                  className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {auto ? <Sparkles className="size-4" strokeWidth={1.5} /> : <ProviderIcon providerId={provider.id} size={20} className="text-dls-text" />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-dls-text">{auto ? "Auto" : provider.name}</span>
                        {!auto && sourceLabel ? (
                          <span className={providerSourceBadgeClassName({ orgManaged, source: provider.source })}>
                            {sourceLabel}
                          </span>
                        ) : null}
                        {props.gatewayProviderIds?.has(provider.id) ? (
                          <Badge variant="outline" className="h-auto px-2 py-0.5 text-[10px] text-muted-foreground">
                            {OPENWORK_GATEWAY_BADGE_LABEL}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{auto ? "Free · OpenWork picks the model" : provider.id}</div>
                    </div>
                  </div>
                  {!managedByCloud ? (
                    <Button
                      variant="destructive"
                      onClick={() => void props.onDisconnectProvider(provider.id)}
                      disabled={
                        props.busy ||
                        props.providerAuthBusy ||
                        !providersReady ||
                        props.disconnectingProviderId !== null ||
                        !props.canDisconnectProvider(provider)
                      }
                    >
                      {props.disconnectingProviderId === provider.id
                        ? t("settings.disconnecting")
                        : props.canDisconnectProvider(provider)
                          ? t("settings.disconnect")
                          : t("settings.managed_by_env")}
                    </Button>
                  ) : null}
                </LayoutSectionItem>
              );
            })}
          </div>
        ) : null}

        {props.gatewayConnectProviders?.map((provider) => (
          <GatewayConnectRow
            key={gatewayConnectProviderKey(provider)}
            provider={provider}
            busy={props.connectingGatewayProviderId === gatewayConnectProviderKey(provider)}
            onConnect={props.onConnectGatewayProvider}
          />
        ))}

        {providersReady && props.showOpenWorkModelsSyncing ? (
          <LayoutSectionItem className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border bg-dls-hover px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProviderIcon providerId="openwork" size={20} className="text-amber-11" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-dls-text">OpenWork Models</span>
                  <span className="shrink-0 rounded-full border border-amber-6 bg-amber-3 px-2 py-0.5 text-[10px] font-medium text-amber-11">
                    Included — syncing
                  </span>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  OpenWork Models will become available automatically when the pending workspace reload completes.
                </div>
              </div>
            </div>
          </LayoutSectionItem>
        ) : null}

        {props.providerConnectError ? (
          <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice>
        ) : null}
        {props.providerDisconnectStatus ? (
          <SettingsNotice>{props.providerDisconnectStatus}</SettingsNotice>
        ) : null}
        {props.providerDisconnectError ? (
          <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice>
        ) : null}

        <LayoutSectionItemFootnote>{t("settings.api_keys_info")}</LayoutSectionItemFootnote>
      </LayoutSection>

      {props.cloudProvidersView}

    </LayoutStack>
  );
}
