import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Building, Check, Cloud, Laptop, Sparkles } from "lucide-react";
import type { ModelOption, ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { ActionContextMenu } from "@/components/ui/action-context-menu";
import type { MenuAction } from "@/components/ui/action-menu-model";
import { Command, CommandCollection, CommandEmpty, CommandGroup, CommandGroupLabel, CommandHeader, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { writeStoredDefaultModel } from "@/react-app/kernel/model-config";
import { immutableModelPin, isAutoModel, isPinModelShortcut, markExplicitModelChoice, modelGroups, modelSource, modelSubtitle, modelTitle, orderedModelPins, type ModelGroup } from "@/react-app/domains/session/models/model-catalog";
import { modelRefKey, useModelCollectionsStore } from "@/react-app/domains/session/models/model-collections-store";

export function ModelSourceIcon({ model }: { model: ModelOption }) {
  const Icon = isAutoModel(model) ? Sparkles : modelSource(model) === "gateway" ? Cloud : modelSource(model) === "organization" ? Building : Laptop;
  return <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />;
}

export function ModelPickerList({ options, current, query, onQueryChange, onSelect, focusAlternative = false, footer, searchInputRef, autoFocusSearch = true }: {
  options: readonly ModelOption[];
  current: ModelRef;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (option: ModelOption) => void;
  focusAlternative?: boolean;
  footer?: ReactNode;
  searchInputRef?: Ref<HTMLInputElement>;
  autoFocusSearch?: boolean;
}) {
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const recent = useModelCollectionsStore((state) => state.recent);
  const groups = modelGroups(options, favorites, recent, query);
  const pins = orderedModelPins(options, favorites);
  const pinned = new Set(pins.map(modelRefKey));
  const root = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState<ModelOption | null>(null);
  const alternative = pins.find((option) => !isAutoModel(option) && modelRefKey(option) !== modelRefKey(current))
    ?? options.find((option) => !option.disabled && !isAutoModel(option) && modelRefKey(option) !== modelRefKey(current));
  const alternativeKey = alternative ? modelRefKey(alternative) : undefined;
  useEffect(() => {
    if (!focusAlternative || !alternativeKey) return;
    const frame = requestAnimationFrame(() => {
      const row = [...(root.current?.querySelectorAll<HTMLElement>("[data-model-key]") ?? [])].find((item) => item.dataset.modelKey === alternativeKey);
      row?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusAlternative, alternativeKey]);
  const toggle = (option: ModelOption) => {
    if (!immutableModelPin(option) && !option.disabled) useModelCollectionsStore.getState().toggleFavorite(option);
  };
  return <div ref={root} className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={(event) => {
    if (!isPinModelShortcut(event) || event.repeat) return;
    const focusedRow = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-model-key]") : null;
    const row = focusedRow ?? root.current?.querySelector<HTMLElement>("[data-model-key][data-highlighted]");
    const option = options.find((item) => modelRefKey(item) === row?.dataset.modelKey) ?? highlighted;
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    toggle(option);
  }}>
    <Command items={groups} filter={null} value={query} onValueChange={onQueryChange}>
      <CommandHeader><CommandInput ref={searchInputRef} autoFocus={autoFocusSearch} aria-label="Search all models" placeholder="Search models..." className="text-base sm:text-base md:text-base lg:text-sm" /></CommandHeader>
      <CommandPanel className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <CommandEmpty>No accessible models found.</CommandEmpty>
        <CommandList>
          {(group: ModelGroup) => <CommandGroup key={group.value} items={group.items}>
            <CommandGroupLabel>{group.value}</CommandGroupLabel>
            <CommandCollection>
              {(option: ModelOption) => {
                const key = modelRefKey(option);
                const name = modelTitle(option);
                const fixed = immutableModelPin(option);
                const active = modelRefKey(current) === key;
                const pinLabel = pinned.has(key) ? "Unpin model" : "Pin model";
                const actions: MenuAction[] = [
                  { type: "item", id: "pin", label: fixed ? "Pinned" : pinLabel, disabled: fixed, onSelect: () => toggle(option) },
                  { type: "item", id: "default", label: "Set as default", onSelect: () => { markExplicitModelChoice(); writeStoredDefaultModel(option); } },
                  { type: "item", id: "select", label: "Switch to model", onSelect: () => onSelect(option) },
                  { type: "item", id: "copy", label: "Copy model ID", onSelect: () => navigator.clipboard.writeText(`${option.providerID}/${option.modelID}`) },
                ];
                return <ActionContextMenu key={key} actions={actions} render={<CommandItem
                  value={`${key} ${name} ${modelSubtitle(option)}`}
                  data-model-key={key} data-checked={active} data-testid={`model-option-${option.providerID}-${option.modelID}`}
                  aria-label={`${name}, ${modelSubtitle(option)}${active ? ", current model" : ""}`}
                  tabIndex={0} className="group/model min-h-10 gap-2 rounded-md px-2 py-2"
                  onFocus={() => setHighlighted(option)}
                  onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); onSelect(option); } }}
                  onClick={() => onSelect(option)}
                />}>
                  <ModelSourceIcon model={option} />
                  <span className="min-w-0 flex-1"><span className="block truncate" title={name}>{name}</span><span className="block truncate text-xs text-muted-foreground">{modelSubtitle(option)}</span></span>
                  {!fixed ? <Button type="button" variant="ghost" size="sm" aria-label={`${pinLabel}: ${name}`} className="h-7 px-2 text-xs opacity-0 group-hover/model:opacity-100 group-focus-within/model:opacity-100 group-data-highlighted/model:opacity-100 focus:opacity-100"
                    onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggle(option); }}>
                    {pinned.has(key) ? "Unpin" : "Pin"}
                  </Button> : null}
                  {active ? <Check aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : null}
                </ActionContextMenu>;
              }}
            </CommandCollection>
          </CommandGroup>}
        </CommandList>
      </CommandPanel>
      {footer}
    </Command>
  </div>;
}
