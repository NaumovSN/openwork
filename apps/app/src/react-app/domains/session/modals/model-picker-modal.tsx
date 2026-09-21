import { useEffect, useRef, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { ModelPickerList } from "@/components/model-picker-list";
import { t } from "@/i18n";
import { getModelBehaviorControls, getModelBehaviorSelection } from "@/app/lib/model-behavior";
import { gatewayConnectCopy, gatewayConnectProviderKey, type GatewayConnectProvider } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import type { ModelOption, ModelRef } from "@/app/types";
import { usePlatform } from "@/react-app/kernel/platform";
import { AutoAccessFooter } from "../../cloud/auto-access-ui";
import { isAutoModel, modelTitle } from "../models/model-catalog";
import { modelRefKey, useModelCollectionsStore } from "../models/model-collections-store";

export const MODEL_PICKER_DEFAULT_SUBTITLE = "Select a model for this session.";
export const MODEL_PICKER_UNAVAILABLE_SUBTITLE = "The model you were using is no longer available, please select a different model for this session.";
export function resolveModelPickerSubtitle(subtitle: string | undefined) { return subtitle ?? MODEL_PICKER_DEFAULT_SUBTITLE; }

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
  disabledProviders?: string[];
  organizationModelsEmpty?: boolean;
  organizationModelsSettingsUrl?: string;
  query: string;
  setQuery: (value: string) => void;
  subtitle?: string;
  target: "default" | "session";
  current: ModelRef;
  currentBehaviorValue?: string | null;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
  openWorkModelsEntitled?: boolean;
  openWorkModelsSyncing?: boolean;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  restrictToCloud?: boolean;
  gatewayProviderIds?: ReadonlySet<string>;
  gatewayConnectProviders?: GatewayConnectProvider[];
  onConnectGatewayProvider?: (provider: GatewayConnectProvider) => void | Promise<void>;
};

export type ModelPickerEmptyState = {
  messageKey: string;
  showConnectProvider: boolean;
  showRefreshOrganizationModels: boolean;
  showOrganizationModelsSettings: boolean;
};
export function resolveModelPickerEmptyState(input: {
  providerGroupCount: number; query: string; organizationModelsEmpty: boolean;
  restrictToCloud: boolean; organizationModelsSettingsUrl?: string;
}): ModelPickerEmptyState | null {
  if (input.providerGroupCount > 0) return null;
  return {
    messageKey: input.query.trim() ? "models.no_models_match_search" : input.organizationModelsEmpty ? "models.organization_models_empty" : "models.no_models_available",
    showConnectProvider: !input.query.trim() && !input.organizationModelsEmpty && !input.restrictToCloud,
    showRefreshOrganizationModels: !input.query.trim() && input.organizationModelsEmpty,
    showOrganizationModelsSettings: !input.query.trim() && input.organizationModelsEmpty && Boolean(input.organizationModelsSettingsUrl),
  };
}

export function ModelPickerModal(props: ModelPickerModalProps) {
  const platform = usePlatform();
  const isMobile = useIsMobile();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const options = props.options.map((option): ModelOption => ({ ...option,
    disabled: option.disabled || props.disabledProviders?.includes(option.providerID),
    source: props.gatewayProviderIds?.has(option.providerID) ? "gateway" : option.source,
  }));
  const selected = options.find((option) => modelRefKey(option) === modelRefKey(props.current));
  const behavior = getModelBehaviorSelection(selected?.behaviorOptions ?? [], props.currentBehaviorValue !== undefined ? props.currentBehaviorValue : selected?.behaviorValue ?? null);
  const controls = getModelBehaviorControls(behavior.options, behavior.value);
  const empty = resolveModelPickerEmptyState({ providerGroupCount: options.filter((option) => !option.disabled).length,
    query: props.query, organizationModelsEmpty: Boolean(props.organizationModelsEmpty), restrictToCloud: Boolean(props.restrictToCloud), organizationModelsSettingsUrl: props.organizationModelsSettingsUrl });
  useEffect(() => { if (props.open) props.setQuery(""); }, [props.open]);
  const refresh = async () => {
    if (refreshing || !props.onRefreshOrganizationModels) return;
    setRefreshing(true);
    try { await props.onRefreshOrganizationModels(); } finally { setRefreshing(false); }
  };
  return <Dialog open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogContent initialFocus={() => isMobile ? titleRef.current : searchInputRef.current} aria-describedby={undefined} className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col overflow-hidden sm:max-w-lg" data-testid="all-models-picker">
      <DialogHeader><DialogTitle ref={titleRef} tabIndex={-1}>Models</DialogTitle></DialogHeader>
      {props.subtitle === MODEL_PICKER_UNAVAILABLE_SUBTITLE ? <p role="status" className="text-sm text-muted-foreground">{props.subtitle}</p> : null}
      <ModelPickerList searchInputRef={searchInputRef} autoFocusSearch={false} options={options} current={props.current} query={props.query} onQueryChange={props.setQuery} onSelect={(option) => {
        useModelCollectionsStore.getState().recordRecent(option);
        props.onSelect({ providerID: option.providerID, modelID: option.modelID });
      }} />
      {selected && !selected.disabled && !isAutoModel(selected) && (controls.options.length > 0 || controls.hasFast) ? <details className="border-t border-border pt-2" data-testid="current-model-settings">
        <summary className="cursor-pointer text-xs">{modelTitle(selected)} · {behavior.label}</summary>
        <p role="status" className="py-2 text-xs text-muted-foreground">{getModelBehaviorSelection(behavior.options, controls.fast ? controls.toggleValue ?? null : behavior.value).description}</p>
        {controls.hasFast ? <Button size="sm" variant="ghost" aria-pressed={controls.fast} disabled={controls.toggleValue === undefined} onClick={() => {
          if (controls.toggleValue !== undefined) props.onBehaviorChange(props.current, controls.toggleValue);
        }}>Fast: {controls.fast ? "On" : "Off"}</Button> : null}
        <div role="group" aria-label="Thinking and effort" className="flex flex-wrap gap-1">{controls.options.map((option) => <Button key={option.value ?? "default"} size="sm" variant="ghost" aria-pressed={option.value === behavior.value} onClick={() => props.onBehaviorChange(props.current, option.value)}>{option.label}</Button>)}</div>
      </details> : null}
      {props.gatewayConnectProviders?.map((provider) => <div key={gatewayConnectProviderKey(provider)} className="flex items-center gap-2 text-sm">
        <Cloud className="size-4" strokeWidth={1.5} /><span className="min-w-0 flex-1 truncate">{gatewayConnectCopy(provider.name)}</span>
        <Button size="sm" variant="ghost" disabled={!props.onConnectGatewayProvider} onClick={() => void props.onConnectGatewayProvider?.(provider)}>Connect</Button>
      </div>)}
      {empty?.showRefreshOrganizationModels ? <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void refresh()}><RefreshCw className="size-4" />{t("models.refresh_organization_models")}</Button> : null}
      {empty?.showOrganizationModelsSettings && props.organizationModelsSettingsUrl ? <Button variant="ghost" size="sm" onClick={() => platform.openLink(props.organizationModelsSettingsUrl!)}>{t("models.manage_organization_models")}</Button> : null}
      {!props.restrictToCloud ? <Button variant="ghost" size="sm" className="self-start" onClick={props.onOpenSettings}>Connect a provider</Button> : null}
      <AutoAccessFooter available={options.some(isAutoModel)} syncing={props.openWorkModelsSyncing} />
      <Button variant="ghost" size="sm" className="self-end" onClick={() => props.onClose()}>Done</Button>
    </DialogContent>
  </Dialog>;
}
