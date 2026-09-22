import { useEffect, useRef, useState } from "react";
import { ChevronRight, Cloud } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSetWorkspaceDefaultModel } from "@/react-app/kernel/use-workspace-model-default";
import { ModelPickerList } from "@/components/model-picker-list";
import { getModelBehaviorControls, getModelBehaviorSelection } from "@/app/lib/model-behavior";
import { gatewayConnectCopy, gatewayConnectProviderKey, isCloudManagedProviderKey, type GatewayConnectProvider } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { filterCloudManagedModelOptions } from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import { filterEntitledModelOptions, isProviderAllowedByDesktopPolicy, hideBuiltInZenFallback } from "@/react-app/domains/connections/provider-auth/provider-policy";
import { useCheckDesktopRestriction } from "../../cloud/desktop-config-provider";
import { useDenAuth } from "../../cloud/den-auth-provider";
import type { ModelOption, ModelRef } from "@/app/types";
import { AutoAccessFooter, openAutoProviderSettings } from "../../cloud/auto-access-ui";
import { isAutoModel, type ModelPickerCatalogState, type RetainedModelSelection } from "../models/model-catalog";
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
  catalogState?: ModelPickerCatalogState;
  retainedSelection?: RetainedModelSelection;
  onSetWorkspaceDefault?: (model: ModelRef, variant?: string | null) => void | boolean | Promise<void | boolean>;
  onOpenProviderSettings?: () => void;
  onReloadWorkspace?: () => void | Promise<unknown>;
};

export type ModelPickerEmptyState = { messageKey: string; showConnectProvider: boolean; showRefreshOrganizationModels: boolean; showOrganizationModelsSettings: boolean };
export function resolveModelPickerEmptyState(input: { providerGroupCount: number; query: string; organizationModelsEmpty: boolean; restrictToCloud: boolean; organizationModelsSettingsUrl?: string }): ModelPickerEmptyState | null {
  if (input.providerGroupCount > 0) return null;
  return { messageKey: input.query.trim() ? "models.no_models_match_search" : input.organizationModelsEmpty ? "models.organization_models_empty" : "models.no_models_available",
    showConnectProvider: !input.query.trim() && !input.organizationModelsEmpty && !input.restrictToCloud,
    showRefreshOrganizationModels: !input.query.trim() && input.organizationModelsEmpty,
    showOrganizationModelsSettings: !input.query.trim() && input.organizationModelsEmpty && Boolean(input.organizationModelsSettingsUrl) };
}

export function ModelPickerModal(props: ModelPickerModalProps) {
  const isMobile = useIsMobile();
  const setWorkspaceDefault = useSetWorkspaceDefaultModel();
  const checkRestriction = useCheckDesktopRestriction();
  const auth = useDenAuth();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [advanced, setAdvanced] = useState(false);
  const restrictToCloud = props.restrictToCloud || checkRestriction({ restriction: "allowCustomProviders" });
  const rawOptions = props.options.map((option): ModelOption => ({ ...option,
    disabled: option.disabled || props.disabledProviders?.includes(option.providerID),
    source: props.gatewayProviderIds?.has(option.providerID) ? "gateway" : option.source,
  }));
  const saved = props.retainedSelection && modelRefKey(props.retainedSelection.model) === modelRefKey(props.current) ? props.retainedSelection : undefined;
  const explicitBlock = saved && ["policy", "disabled"].includes(saved.reason);
  const options = hideBuiltInZenFallback(filterEntitledModelOptions(filterCloudManagedModelOptions(rawOptions, auth.isSignedIn), { restrictToCloud, checkRestriction }))
    .filter((option) => !explicitBlock || modelRefKey(option) !== modelRefKey(props.current));
  const selected = options.find((option) => modelRefKey(option) === modelRefKey(props.current));
  const known = rawOptions.find((option) => modelRefKey(option) === modelRefKey(props.current));
  const policyBlocked = Boolean(props.current.providerID) && !isProviderAllowedByDesktopPolicy({ providerId: props.current.providerID, restrictToCloud, checkRestriction });
  const signedOutModel = !auth.isSignedIn && isCloudManagedProviderKey(props.current.providerID);
  const implicitStarter = !known && !saved && props.current.providerID === "opencode" && props.current.modelID === "big-pickle";
  const retained: RetainedModelSelection | undefined = !selected && !implicitStarter && props.current.providerID && props.current.modelID
    ? { model: props.current, title: signedOutModel ? undefined : known?.title ?? saved?.title,
      description: signedOutModel ? undefined : known?.description ?? saved?.description,
      reason: policyBlocked ? "policy" : signedOutModel ? "signed-out" : saved?.reason ?? (known?.disabled || props.disabledProviders?.includes(props.current.providerID) ? "disabled" : "unavailable") } : undefined;
  const behavior = getModelBehaviorSelection(selected?.behaviorOptions ?? [], props.currentBehaviorValue !== undefined ? props.currentBehaviorValue : selected?.behaviorValue ?? null);
  const controls = getModelBehaviorControls(behavior.options, behavior.value);
  const catalogState = props.catalogState ?? { state: "ready", onRetry: props.onRefreshOrganizationModels } satisfies ModelPickerCatalogState;
  const autoVisible = !policyBlocked && !explicitBlock && !props.disabledProviders?.includes(props.current.providerID) && (options.some(isAutoModel) || isAutoModel(props.current));
  useEffect(() => { if (props.open) { props.setQuery(""); setAdvanced(false); } }, [props.open]);
  const openSettings = () => { props.onClose({ restorePromptFocus: false }); (props.onOpenProviderSettings ?? openAutoProviderSettings)(); };
  return <Dialog open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogContent initialFocus={() => isMobile ? titleRef.current : searchInputRef.current} aria-describedby={undefined} className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col overflow-hidden rounded-2xl sm:max-w-90" data-testid="all-models-picker">
      <DialogHeader><DialogTitle ref={titleRef} tabIndex={-1}>Models</DialogTitle></DialogHeader>
      <ModelPickerList searchInputRef={searchInputRef} autoFocusSearch={false} options={options} current={props.current} query={props.query} onQueryChange={props.setQuery}
        catalogState={catalogState} retainedSelection={retained} onSetWorkspaceDefault={props.onSetWorkspaceDefault ?? setWorkspaceDefault} currentBehaviorValue={behavior.value}
        onConnectProvider={!restrictToCloud ? props.onOpenSettings : undefined} onOpenProviderSettings={!checkRestriction({ restriction: "allowControlSettings" }) ? openSettings : undefined}
        openWorkModelsSyncing={autoVisible && props.openWorkModelsSyncing} onReloadWorkspace={props.onReloadWorkspace} onRetryAuto={catalogState.onRetry}
        onSelect={(option) => { if (!options.some((item) => modelRefKey(item) === modelRefKey(option) && !item.disabled)) return; useModelCollectionsStore.getState().recordRecent(option); props.onSelect({ providerID: option.providerID, modelID: option.modelID }); }} />
      <details open={advanced} className="group/advanced border-t border-border" data-testid="current-model-settings">
        <summary onClick={(event) => { event.preventDefault(); setAdvanced((value) => !value); }} className="flex h-11 cursor-pointer list-none items-center gap-2 text-sm"><ChevronRight className="size-4 transition-transform group-open/advanced:rotate-90" />Advanced options</summary>
        {advanced ? <div className="pb-2 pl-6">
          {selected && !isAutoModel(selected) ? <>
            <div className="flex h-11 items-center justify-between text-sm"><span>Effort</span><span className="text-muted-foreground">{behavior.label}</span></div>
            <p role="status" className="pb-2 text-xs text-muted-foreground">{getModelBehaviorSelection(behavior.options, controls.fast ? controls.toggleValue ?? null : behavior.value).description}</p>
            <div role="group" aria-label="Thinking and effort" className="flex flex-wrap gap-1">{controls.options.map((option) => <Button key={option.value ?? "default"} size="sm" variant="ghost" aria-pressed={option.value === behavior.value} onClick={() => props.onBehaviorChange(props.current, option.value)}>{option.label}</Button>)}</div>
            {controls.hasFast ? <div className="flex h-11 items-center justify-between text-sm"><span>Fast mode</span><Switch aria-label="Fast mode" size="sm" checked={controls.fast} disabled={controls.toggleValue === undefined} onCheckedChange={() => { if (controls.toggleValue !== undefined) props.onBehaviorChange(props.current, controls.toggleValue); }} /></div> : null}
          </> : <p className="text-sm text-muted-foreground">{isAutoModel(props.current) ? "Auto manages its model settings." : "Choose an available model to change its settings."}</p>}
        </div> : null}
      </details>
      {props.gatewayConnectProviders?.map((provider) => <div key={gatewayConnectProviderKey(provider)} className="flex items-center gap-2 text-sm">
        <Cloud className="size-4" strokeWidth={1.5} /><span className="min-w-0 flex-1 truncate">{gatewayConnectCopy(provider.name)}</span>
        <Button size="sm" variant="ghost" disabled={!props.onConnectGatewayProvider} onClick={() => void props.onConnectGatewayProvider?.(provider)}>Connect</Button>
      </div>)}
      {!restrictToCloud ? <Button variant="ghost" size="sm" className="self-start" onClick={props.onOpenSettings}>Connect more providers</Button> : null}
      <AutoAccessFooter available={autoVisible} syncing={autoVisible && props.openWorkModelsSyncing} />
      <Button variant="ghost" size="sm" className="self-end" onClick={() => props.onClose()}>Done</Button>
    </DialogContent>
  </Dialog>;
}
