import type { UIMessage } from "ai";
import { isAutoModel } from "../models/model-catalog";

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

export function replyModelFromInfo(info: unknown) {
  if (field(info, "role") !== "assistant") return undefined;
  const resolved = field(info, "resolvedModel");
  const model = field(info, "model");
  const modelID = text(field(resolved, "modelID")) ?? text(field(resolved, "id"))
    ?? text(field(info, "resolvedModelID")) ?? text(field(info, "modelID")) ?? text(field(model, "id"));
  const providerID = text(field(resolved, "providerID")) ?? text(field(info, "providerID")) ?? text(field(model, "providerID"));
  if (!modelID) return undefined;
  return { modelID, ...(providerID ? { providerID } : {}) };
}

export function mergeReplyMetadata(previous: unknown, next: unknown) {
  const record = (value: unknown): object => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { ...record(previous), ...record(next), opencode: {
    ...record(field(previous, "opencode")), ...record(field(next, "opencode")),
  } };
}

export function replyModelLabel(message: UIMessage) {
  const model = field(field(message.metadata, "opencode"), "replyModel");
  const modelID = text(field(model, "modelID"));
  const providerID = text(field(model, "providerID")) ?? "";
  if (!modelID || isAutoModel({ providerID, modelID }) || (providerID.startsWith("ipr_") && modelID.startsWith("gwm_"))) return null;
  return modelID;
}
