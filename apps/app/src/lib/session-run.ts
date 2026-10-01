import type { UIMessage } from "ai";

export function messageActivity(message: UIMessage): Record<string, unknown> {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return {};
  const value = metadata.opencode;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function reasoningProviderMetadata(part: { id: string; time?: { start: number; end?: number } }) {
  return { opencode: { partId: part.id,
    ...(part.time ? { startedAt: part.time.start, ...(part.time.end === undefined ? {} : { endedAt: part.time.end }) } : {}) } };
}

export function projectedMessageMetadata(info: { time?: { created?: number; completed?: number }; parentID?: unknown; model?: unknown; modelID?: unknown; providerID?: unknown; error?: unknown; replyModel?: unknown }) {
  return { opencode: {
    ...(typeof info.time?.created === "number" ? { created: info.time.created } : {}),
    ...(typeof info.time?.completed === "number" ? { completed: info.time.completed } : {}),
    ...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
    ...(info.model ? { model: info.model } : typeof info.modelID === "string" ? { model: { modelID: info.modelID, providerID: info.providerID } } : {}),
    ...(info.replyModel ? { replyModel: info.replyModel } : {}),
    ...(info.error ? { outcome: typeof info.error === "object" && "name" in info.error && info.error.name === "MessageAbortedError" ? "stopped" : "failed" } : {}),
  } };
}

