import type { ModelOption, ModelRef } from "@/app/types";
import type { CloudImportedProvider } from "@/app/cloud/import-state";
import { modelRefKey, nextFavoriteModel } from "./model-collections-store";

export const AUTO_MODEL_ID = "openai/gpt-5.6-luna";
export const AUTO_PROVIDER_ID = "openwork-free";
export const EXPLICIT_MODEL_CHOICE_KEY = "openwork.modelChoice.explicit";
export function shouldSelectInitialAuto(input: { available: readonly ModelRef[]; current: ModelRef | null; empty: boolean; explicit: boolean }) {
  return input.empty && !input.explicit && input.available.some(isAutoModel)
    && (!input.current || (input.current.providerID === "opencode" && input.current.modelID === "big-pickle"));
}
export function markExplicitModelChoice() {
  try { window.localStorage.setItem(EXPLICIT_MODEL_CHOICE_KEY, "1"); } catch {}
}
export type ModelSource = "gateway" | "local" | "organization";
export const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  gateway: "OpenWork Gateway", local: "Local", organization: "Organization",
};

export function isAutoModel(model: ModelRef | null | undefined) {
  return model?.modelID === AUTO_MODEL_ID && (model.providerID === AUTO_PROVIDER_ID || model.providerID === "openwork");
}

export function modelSource(model: ModelRef & { source?: ModelOption["source"] }): ModelSource {
  if (isAutoModel(model) || model.providerID === "openwork" || model.source === "gateway" || model.providerID.startsWith("ipr_")) return "gateway";
  if (model.source === "cloud" || model.providerID.startsWith("lpr_")) return "organization";
  return "local";
}

export function modelTitle(model: ModelRef & { title?: string }) {
  return isAutoModel(model) ? "Auto" : model.title || model.modelID;
}

export function modelSubtitle(model: ModelOption) {
  return isAutoModel(model) ? "Free · OpenWork picks the model" : `${model.description || model.providerID} · ${MODEL_SOURCE_LABELS[modelSource(model)]}`;
}

export function withImportedModelMetadata(options: readonly ModelOption[], imports: Record<string, CloudImportedProvider>) {
  const pins = new Map<string, number>();
  const sources = new Map<string, ModelOption["source"]>();
  for (const provider of Object.values(imports)) {
    sources.set(provider.providerId, provider.source === "openwork_gateway" ? "gateway" : "cloud");
    for (const id of provider.pinnedModelIds ?? []) {
      const key = modelRefKey({ providerID: provider.providerId, modelID: id });
      if (provider.modelIds.includes(id) && !pins.has(key)) pins.set(key, pins.size);
    }
  }
  return options.map((option) => ({ ...option,
    source: sources.get(option.providerID) ?? option.source,
    organizationPinOrder: pins.get(modelRefKey(option)) ?? option.organizationPinOrder,
  }));
}

export function immutableModelPin(model: ModelOption) {
  return isAutoModel(model) || model.organizationPinOrder !== undefined;
}

export function orderedModelPins(options: readonly ModelOption[], personal: readonly ModelRef[]) {
  const available = options.filter((option) => !option.disabled);
  const byKey = new Map(available.map((option) => [modelRefKey(option), option]));
  const ordered = [
    ...available.filter((option) => option.organizationPinOrder !== undefined).sort((a, b) => a.organizationPinOrder! - b.organizationPinOrder!),
    ...personal.flatMap((model) => { const option = byKey.get(modelRefKey(model)); return option ? [option] : []; }),
    ...available.filter(isAutoModel),
  ];
  return [...new Map(ordered.map((option) => [modelRefKey(option), option])).values()];
}

export function nextPinnedModel(options: readonly ModelOption[], personal: readonly ModelRef[], current: ModelRef | null) {
  return nextFavoriteModel(orderedModelPins(options, personal), current);
}

export function nextModelSource(options: readonly ModelOption[], pins: readonly ModelOption[], current: ModelRef | null) {
  const available = [...pins, ...options].filter((option) => !option.disabled);
  const sources = [...new Set(available.map(modelSource))];
  if (sources.length < 2) return null;
  const source = current ? modelSource(options.find((option) => modelRefKey(option) === modelRefKey(current)) ?? current) : null;
  const index = source ? sources.indexOf(source) : -1;
  const next = sources[(index + 1) % sources.length];
  return available.find((option) => modelSource(option) === next) ?? null;
}

export type ModelGroup = { value: string; items: ModelOption[] };
export function modelGroups(options: readonly ModelOption[], personal: readonly ModelRef[], recent: readonly ModelRef[], query = ""): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const shown = new Set<string>();
  const search = query.trim().toLowerCase();
  const available = options.filter((option) => !option.disabled);
  const add = (value: string, candidates: readonly ModelOption[]) => {
    const items = candidates.filter((option) => {
      const key = modelRefKey(option);
      if (shown.has(key) || (search && !`${modelTitle(option)} ${modelSubtitle(option)} ${key}`.toLowerCase().includes(search))) return false;
      shown.add(key);
      return true;
    });
    if (items.length) groups.push({ value, items });
  };
  add("Pinned", orderedModelPins(available, personal));
  add("Recent", recent.flatMap((model) => available.filter((option) => modelRefKey(option) === modelRefKey(model))));
  add("OpenWork Models", available.filter((option) => option.providerID === "openwork" || option.providerID === AUTO_PROVIDER_ID));
  const providers = [...new Set(available.map((option) => option.providerID))].sort((a, b) => {
    const name = (id: string) => available.find((option) => option.providerID === id)?.description || id;
    return name(a).localeCompare(name(b));
  });
  for (const id of providers) {
    const models = available.filter((option) => option.providerID === id).sort((a, b) => modelTitle(a).localeCompare(modelTitle(b)));
    add(models[0]?.description || id, models);
  }
  return groups;
}

export function isPinModelShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "p" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isCycleModelSourceShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "m" && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;
}
