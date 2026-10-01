import type { ModelRef } from "../types";

export const AUTO_MODEL_ID = "openai/gpt-6-luna";
export const LEGACY_AUTO_MODEL_ID = "openai/gpt-5.6-luna";
export const AUTO_PROVIDER_ID = "openwork-free";

/** Upgrade saved Auto choices without changing a person's explicit BYOK model. */
export function currentAutoModel(model: ModelRef): ModelRef {
  return model.modelID === LEGACY_AUTO_MODEL_ID && (model.providerID === AUTO_PROVIDER_ID || model.providerID === "openwork")
    ? { ...model, modelID: AUTO_MODEL_ID } : model;
}
