"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import type { ModelOption, ModelRef } from "@/app/types";
import { getModelBehaviorControls, getModelBehaviorSelection, getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ModelPickerList } from "@/components/model-picker-list";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { useSetWorkspaceDefaultModel } from "@/react-app/kernel/use-workspace-model-default";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { AutoAccessFooter, openAutoProviderSettings, useObservedAutoAccessSnapshot } from "@/react-app/domains/cloud/auto-access-ui";
import { filterCloudManagedModelOptions, mergeModelOptions } from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { filterEntitledModelOptions, hideBuiltInZenFallback, isProviderAllowedByDesktopPolicy } from "@/react-app/domains/connections/provider-auth/provider-policy";
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { openModelPickerEvent, openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { newProvidersEvent } from "@/app/lib/provider-events";
import { openComposerModelPickerEvent } from "@/app/lib/inference-access";
import { isAutoModel, nonDefaultModelSummary, withAutoDefaultPin, type ModelPickerCatalogState, type RetainedModelSelection } from "@/react-app/domains/session/models/model-catalog";
import { modelRefKey, useModelCollectionsStore, useModelPickerCatalogStore } from "@/react-app/domains/session/models/model-collections-store";

interface ModelSelectProps {
  open: boolean;
  value: ModelRef;
  hideValue?: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (model: ModelRef, variant?: string | null) => void;
  disabled?: boolean;
  sessionId?: string;
  openWorkModelsEntitled?: boolean;
  openWorkModelsSyncing?: boolean;
  fallbackOptions?: readonly ModelOption[];
  behaviorValue?: string | null;
  behaviorLabel?: string;
  behaviorOptions?: { value: string | null; label: string }[];
  onBehaviorChange?: (value: string | null) => void;
  onSetWorkspaceDefault?: (model: ModelRef, variant?: string | null) => void | boolean | Promise<void | boolean>;
  onReloadWorkspace?: () => void | Promise<unknown>;
  retainedSelection?: RetainedModelSelection;
}

export function ModelSelect({ open, value, hideValue = false, onOpenChange, onChange, disabled = false, sessionId,
  openWorkModelsSyncing = false, fallbackOptions = [], behaviorValue = null, behaviorOptions = [], onBehaviorChange, onSetWorkspaceDefault, onReloadWorkspace, retainedSelection: savedSelection }: ModelSelectProps) {
  const [query, setQuery] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [effort, setEffort] = React.useState(false);
  const [focusAlternative, setFocusAlternative] = React.useState(false);
  const isMobile = useIsMobile();
  const popupRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const effortButtonRef = React.useRef<HTMLButtonElement>(null);
  const backButtonRef = React.useRef<HTMLButtonElement>(null);
  const previousEffort = React.useRef(effort);
  React.useLayoutEffect(() => {
    const previous = previousEffort.current;
    previousEffort.current = effort;
    if (!open || previous === effort) return;
    (effort ? backButtonRef.current : effortButtonRef.current)?.focus({ preventScroll: true });
  }, [effort, open]);
  const workspace = useWorkspace();
  const setWorkspaceDefault = useSetWorkspaceDefaultModel();
  const auth = useDenAuth();
  const checkRestriction = useCheckDesktopRestriction();
  const providers = useProviderListQuery({ client: workspace.client, baseUrl: workspace.opencodeBaseUrl, directory: workspace.selectedWorkspaceRoot, enabled: Boolean(workspace.client) });
  React.useEffect(() => {
    if (open && workspace.client) void providers.refetch();
  }, [open, providers.refetch, workspace.client]);
  React.useEffect(() => {
    if (!workspace.client) return;
    const refresh = () => { void providers.refetch(); };
    window.addEventListener(newProvidersEvent, refresh);
    return () => window.removeEventListener(newProvidersEvent, refresh);
  }, [providers.refetch, workspace.client]);
  React.useEffect(() => {
    const recover = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.sessionId !== sessionId) return;
      setQuery(""); setAdvanced(false); setEffort(false); setFocusAlternative(true); onOpenChange(true);
    };
    window.addEventListener(openComposerModelPickerEvent, recover);
    return () => window.removeEventListener(openComposerModelPickerEvent, recover);
  }, [sessionId, onOpenChange]);
  const rawOptions = React.useMemo(() => {
    const runtime = getConnectedProviderItems(providers.data).flatMap((provider) => Object.entries(provider.models).map(([id, model]): ModelOption => {
      const summary = getModelBehaviorSummary(provider.id, model, null, provider.name);
      return { providerID: provider.id, modelID: id, title: model.name || "", description: provider.name,
        behaviorTitle: summary.title, behaviorLabel: summary.label, behaviorDescription: summary.description,
        behaviorValue: summary.value, behaviorOptions: summary.options, isFree: isAutoModel({ providerID: provider.id, modelID: id }) };
    }));
    return filterCloudManagedModelOptions(mergeModelOptions(runtime, providers.data?.all ? fallbackOptions.filter((option) => runtime.some((model) => modelRefKey(model) === modelRefKey(option))) : fallbackOptions), auth.isSignedIn);
  }, [providers.data, fallbackOptions, auth.isSignedIn]);
  const restrictToCloud = checkRestriction({ restriction: "allowCustomProviders" });
  const autoSnapshot = useObservedAutoAccessSnapshot();
  const autoStatus = autoSnapshot?.data;
  const explicitBlock = savedSelection && modelRefKey(savedSelection.model) === modelRefKey(value) && ["policy", "disabled"].includes(savedSelection.reason);
  const options = React.useMemo(() => withAutoDefaultPin(hideBuiltInZenFallback(filterEntitledModelOptions(rawOptions, { restrictToCloud, checkRestriction }))
    .filter((option) => !explicitBlock || modelRefKey(option) !== modelRefKey(value)), autoStatus), [rawOptions, restrictToCloud, checkRestriction, autoStatus, explicitBlock, value]);
  const policyBlocked = Boolean(value.providerID) && !isProviderAllowedByDesktopPolicy({ providerId: value.providerID, restrictToCloud, checkRestriction });
  const catalogState: ModelPickerCatalogState = { state: providers.isError ? "error" : workspace.client && providers.isPending ? "loading" : "ready",
    lastVerifiedAt: providers.dataUpdatedAt || undefined, refreshing: providers.isFetching, onRetry: workspace.client ? () => providers.refetch() : undefined };
  const actionOptions = React.useMemo(() => options.map((option) => isAutoModel(option)
    && (openWorkModelsSyncing || autoSnapshot?.status === "error" || (autoStatus && modelRefKey(autoStatus) === modelRefKey(option) && autoStatus.state !== "ready"))
    ? { ...option, disabled: true } : option), [options, openWorkModelsSyncing, autoSnapshot?.status, autoStatus]);
  const catalogOwner = React.useRef(Symbol());
  React.useLayoutEffect(() => {
    if (sessionId) useModelPickerCatalogStore.getState().publish(sessionId, catalogOwner.current, actionOptions);
  }, [sessionId, actionOptions]);
  React.useEffect(() => {
    const owner = catalogOwner.current;
    return () => { if (sessionId) useModelPickerCatalogStore.getState().release(sessionId, owner); };
  }, [sessionId]);
  const selected = options.find((option) => modelRefKey(option) === modelRefKey(value));
  const selectionScope = JSON.stringify([workspace.opencodeBaseUrl, workspace.workspaceId, auth.status, auth.verifiedIdentity]);
  const remembered = React.useRef<{ scope: string; option: ModelOption } | null>(null);
  React.useEffect(() => { if (selected) remembered.current = { scope: selectionScope, option: selected }; }, [selected, selectionScope]);
  const known = rawOptions.find((option) => modelRefKey(option) === modelRefKey(value))
    ?? (remembered.current?.scope === selectionScope && modelRefKey(remembered.current.option) === modelRefKey(value) ? remembered.current.option : undefined);
  const signedOutModel = !auth.isSignedIn && isCloudManagedProviderKey(value.providerID);
  const saved = savedSelection && modelRefKey(savedSelection.model) === modelRefKey(value) ? savedSelection : undefined;
  const implicitStarter = !sessionId && !known && !saved && value.providerID === "opencode" && value.modelID === "big-pickle";
  const retainedSelection: RetainedModelSelection | undefined = !selected && !implicitStarter && value.providerID && value.modelID && (catalogState.state !== "loading" || policyBlocked || signedOutModel)
    ? { model: value, title: signedOutModel ? undefined : known?.title ?? saved?.title, description: signedOutModel ? undefined : known?.description ?? saved?.description,
      reason: policyBlocked ? "policy" : signedOutModel ? "signed-out" : saved?.reason ?? (known?.disabled ? "disabled" : "unavailable") } : undefined;
  const selectedBehavior = getModelBehaviorSelection(selected?.behaviorOptions ?? behaviorOptions, behaviorValue);
  const controls = getModelBehaviorControls(selectedBehavior.options, selectedBehavior.value);
  const hasEffort = behaviorValue !== null || (selected?.behaviorOptions ?? behaviorOptions).some((option) => option.value !== null);
  const summary = nonDefaultModelSummary(value, behaviorValue, selectedBehavior.label === "Default + Fast" ? "Fast" : selectedBehavior.label);
  const select = (option: ModelOption) => {
    if (option.disabled || !options.some((item) => modelRefKey(item) === modelRefKey(option))) return;
    useModelCollectionsStore.getState().recordRecent(option);
    onChange({ providerID: option.providerID, modelID: option.modelID });
    onOpenChange(false);
  };
  const openProvider = () => { setQuery(""); setAdvanced(false); setEffort(false); onOpenChange(false); window.dispatchEvent(new Event(openProviderAuthEvent)); };
  const openSettings = () => { onOpenChange(false); openAutoProviderSettings(); };
  const autoVisible = !policyBlocked && !explicitBlock && (options.some(isAutoModel) || isAutoModel(value));
  return <Popover open={open} onOpenChange={(next) => {
    setQuery(""); setAdvanced(false); setEffort(false); setFocusAlternative(false); onOpenChange(next);
  }}>
    <PopoverTrigger type="button" disabled={disabled} aria-label="Change model"
      className="inline-flex h-9 min-w-0 items-center gap-1.5 px-2.5 text-sm text-muted-foreground hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
      <span className="max-w-56 truncate">{hideValue ? "Select model" : isAutoModel(value) ? "Auto" : selected?.title || known?.title || "Select model"}{!hideValue && summary ? ` · ${summary}` : ""}</span><ChevronDown className="size-3" />
    </PopoverTrigger>
    <PopoverContent ref={popupRef} tabIndex={-1} align="start" initialFocus={() => isMobile || focusAlternative ? popupRef.current : searchInputRef.current} data-testid="composer-model-picker" className="flex max-h-[min(var(--available-height),36rem)] w-90 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl p-0">
      {effort && selected ? <div data-slot="model-thinking-submenu" className="overflow-y-auto p-2">
        <Button ref={backButtonRef} variant="ghost" size="sm" onClick={() => setEffort(false)}><ChevronLeft className="size-4" />Back to models</Button>
        <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{getModelBehaviorSelection(selectedBehavior.options, controls.fast ? controls.toggleValue ?? null : behaviorValue).description}</p>
        {controls.options.map((option) => <Button key={option.value ?? "default"} variant="ghost" className="h-11 w-full justify-between" aria-pressed={option.value === behaviorValue} onClick={() => { onBehaviorChange?.(option.value); setEffort(false); }}>
          {option.label}{option.value === behaviorValue ? <Check className="size-4" /> : null}
        </Button>)}
      </div> : <ModelPickerList searchInputRef={searchInputRef} autoFocusSearch={false} options={options} current={value} query={query} onQueryChange={setQuery} onSelect={select}
        focusAlternative={focusAlternative} catalogState={catalogState} retainedSelection={retainedSelection} onConnectProvider={!restrictToCloud ? openProvider : undefined}
        onOpenProviderSettings={!checkRestriction({ restriction: "allowControlSettings" }) ? openSettings : undefined}
        onSetWorkspaceDefault={onSetWorkspaceDefault ?? setWorkspaceDefault} currentBehaviorValue={behaviorValue} openWorkModelsSyncing={autoVisible && openWorkModelsSyncing} onReloadWorkspace={onReloadWorkspace} onRetryAuto={catalogState.onRetry} footer={<>
        <details open={advanced} className="group/advanced border-t border-border" data-testid="model-advanced-options">
          <summary onClick={(event) => { event.preventDefault(); setAdvanced((value) => !value); }} className="flex h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm focus-visible:ring-2 focus-visible:ring-ring"><ChevronRight className="size-4 transition-transform group-open/advanced:rotate-90" />Advanced options</summary>
          {advanced ? <div className="px-3 pb-2">
            {selected && onBehaviorChange && !isAutoModel(selected) ? <>
              <Button ref={effortButtonRef} data-testid="model-effort" size="sm" variant="ghost" className="h-11 w-full justify-between" disabled={!hasEffort} onClick={() => setEffort(true)}>Effort<span className="text-muted-foreground">{hasEffort ? controls.options.find((option) => option.value === behaviorValue)?.label ?? selectedBehavior.label : "Unavailable"}</span></Button>
              {controls.hasFast ? <div className="flex h-11 items-center justify-between px-2 text-sm"><span>Fast mode</span><Switch aria-label="Fast mode" size="sm" checked={controls.fast} disabled={controls.toggleValue === undefined} onCheckedChange={() => { if (controls.toggleValue !== undefined) onBehaviorChange(controls.toggleValue); }} /></div> : null}
            </> : <p className="px-2 py-2 text-sm text-muted-foreground">{isAutoModel(value) ? "Auto manages its model settings." : "Choose an available model to change its settings."}</p>}
          </div> : null}
        </details>
        <div className="flex items-center justify-between border-t border-border px-2 py-1">
          {!restrictToCloud ? <Button variant="ghost" size="sm" className="h-9" onClick={openProvider}>Connect more providers</Button> : <span />}
          <Button variant="ghost" size="sm" className="h-9" onClick={() => { onOpenChange(false); window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId } })); }}>All models</Button>
        </div>
        <AutoAccessFooter available={autoVisible} syncing={autoVisible && openWorkModelsSyncing} />
      </>} />}
    </PopoverContent>
  </Popover>;
}
