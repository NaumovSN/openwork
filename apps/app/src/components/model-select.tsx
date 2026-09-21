"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronLeft } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import type { ModelOption, ModelRef } from "@/app/types";
import { getModelBehaviorControls, getModelBehaviorSelection, getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ModelPickerList } from "@/components/model-picker-list";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { AutoAccessFooter } from "@/react-app/domains/cloud/auto-access-ui";
import { filterCloudManagedModelOptions, mergeModelOptions } from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import { filterEntitledModelOptions } from "@/react-app/domains/connections/provider-auth/provider-policy";
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { newProvidersEvent } from "@/app/lib/provider-events";
import { openComposerModelPickerEvent } from "@/app/lib/inference-access";
import { isAutoModel } from "@/react-app/domains/session/models/model-catalog";
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
}

export function ModelSelect({ open, value, hideValue = false, onOpenChange, onChange, disabled = false, sessionId,
  openWorkModelsSyncing = false, fallbackOptions = [], behaviorValue = null, behaviorOptions = [], onBehaviorChange }: ModelSelectProps) {
  const [query, setQuery] = React.useState("");
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
  const auth = useDenAuth();
  const checkRestriction = useCheckDesktopRestriction();
  const providers = useProviderListQuery({ client: workspace.client, baseUrl: workspace.opencodeBaseUrl, directory: workspace.selectedWorkspaceRoot, enabled: Boolean(workspace.client) });
  React.useEffect(() => {
    if (open && workspace.client) void providers.refetch();
  }, [open, providers.refetch, workspace.client]);
  React.useEffect(() => {
    const refresh = () => { void providers.refetch(); };
    window.addEventListener(newProvidersEvent, refresh);
    return () => window.removeEventListener(newProvidersEvent, refresh);
  }, [providers.refetch]);
  React.useEffect(() => {
    const recover = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.sessionId !== sessionId) return;
      setQuery(""); setEffort(false); setFocusAlternative(true); onOpenChange(true);
    };
    window.addEventListener(openComposerModelPickerEvent, recover);
    return () => window.removeEventListener(openComposerModelPickerEvent, recover);
  }, [sessionId, onOpenChange]);
  const options = React.useMemo(() => {
    const runtime = getConnectedProviderItems(providers.data).flatMap((provider) => Object.entries(provider.models).map(([id, model]): ModelOption => {
      const summary = getModelBehaviorSummary(provider.id, model, null, provider.name);
      return { providerID: provider.id, modelID: id, title: model.name || "", description: provider.name,
        behaviorTitle: summary.title, behaviorLabel: summary.label, behaviorDescription: summary.description,
        behaviorValue: summary.value, behaviorOptions: summary.options, isFree: isAutoModel({ providerID: provider.id, modelID: id }) };
    }));
    return filterEntitledModelOptions(filterCloudManagedModelOptions(mergeModelOptions(runtime, providers.data?.all ? fallbackOptions.filter((option) => runtime.some((model) => modelRefKey(model) === modelRefKey(option))) : fallbackOptions), auth.isSignedIn), {
      restrictToCloud: checkRestriction({ restriction: "allowCustomProviders" }), checkRestriction,
    });
  }, [providers.data, fallbackOptions, auth.isSignedIn, checkRestriction]);
  const catalogOwner = React.useRef(Symbol());
  React.useLayoutEffect(() => {
    if (sessionId) useModelPickerCatalogStore.getState().publish(sessionId, catalogOwner.current, options);
  }, [sessionId, options]);
  React.useEffect(() => {
    const owner = catalogOwner.current;
    return () => { if (sessionId) useModelPickerCatalogStore.getState().release(sessionId, owner); };
  }, [sessionId]);
  const selected = options.find((option) => modelRefKey(option) === modelRefKey(value));
  const selectedBehavior = getModelBehaviorSelection(selected?.behaviorOptions ?? behaviorOptions, behaviorValue);
  const controls = getModelBehaviorControls(selectedBehavior.options, selectedBehavior.value);
  const hasEffort = behaviorValue !== null || (selected?.behaviorOptions ?? behaviorOptions).some((option) => option.value !== null);
  const select = (option: ModelOption) => {
    if (option.disabled) return;
    useModelCollectionsStore.getState().recordRecent(option);
    onChange({ providerID: option.providerID, modelID: option.modelID });
    onOpenChange(false);
  };
  const openProvider = () => { setQuery(""); setEffort(false); onOpenChange(false); window.dispatchEvent(new Event(openProviderAuthEvent)); };
  return <Popover open={open} onOpenChange={(next) => {
    setQuery(""); setEffort(false); setFocusAlternative(false); onOpenChange(next);
  }}>
    <PopoverTrigger type="button" disabled={disabled} aria-label="Change model"
      className="inline-flex min-w-0 items-center gap-1 px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
      <span className="max-w-56 truncate">{hideValue ? "Select model" : selected && isAutoModel(selected) ? "Auto" : selected?.title || "Select model"}</span><ChevronDown className="size-3" />
    </PopoverTrigger>
    <PopoverContent ref={popupRef} tabIndex={-1} align="start" initialFocus={() => isMobile || focusAlternative ? popupRef.current : searchInputRef.current} data-testid="composer-model-picker" className="flex max-h-[min(var(--available-height),36rem)] w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0">
      {effort && selected ? <div data-slot="model-thinking-submenu" className="overflow-y-auto p-2">
        <Button ref={backButtonRef} variant="ghost" size="sm" onClick={() => setEffort(false)}><ChevronLeft className="size-4" />Back to models</Button>
        <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{getModelBehaviorSelection(selectedBehavior.options, controls.fast ? controls.toggleValue ?? null : behaviorValue).description}</p>
        {controls.options.map((option) => <Button key={option.value ?? "default"} variant="ghost" className="w-full justify-between" aria-pressed={option.value === behaviorValue} onClick={() => { onBehaviorChange?.(option.value); setEffort(false); }}>
          {option.label}{option.value === behaviorValue ? <Check className="size-4" /> : null}
        </Button>)}
      </div> : <ModelPickerList searchInputRef={searchInputRef} autoFocusSearch={false} options={options} current={value} query={query} onQueryChange={setQuery} onSelect={select} focusAlternative={focusAlternative} footer={<>
        {selected && onBehaviorChange && !isAutoModel(selected) && controls.options.length > 0 ? <div className="border-t border-border px-2 py-1">
          <Button ref={effortButtonRef} data-testid="model-effort" size="sm" variant="ghost" className="w-full justify-between" disabled={!hasEffort} onClick={() => setEffort(true)}>Thinking and effort<span className="text-muted-foreground">{hasEffort ? controls.options.find((option) => option.value === behaviorValue)?.label ?? selectedBehavior.label : "Unavailable"}</span></Button>
          {controls.hasFast ? <div className="flex items-center justify-between px-2 py-1 text-xs"><span>Fast mode</span><Switch aria-label="Fast mode" size="sm" checked={controls.fast} disabled={controls.toggleValue === undefined} onCheckedChange={() => {
            if (controls.toggleValue !== undefined) onBehaviorChange(controls.toggleValue);
          }} /></div> : null}
        </div> : null}
        {!checkRestriction({ restriction: "allowCustomProviders" }) ? <div className="border-t border-border px-2 py-1"><Button variant="ghost" size="sm" onClick={openProvider}>Connect a provider</Button></div> : null}
        <AutoAccessFooter available={options.some(isAutoModel)} syncing={openWorkModelsSyncing} />
      </>} />}
    </PopoverContent>
  </Popover>;
}
