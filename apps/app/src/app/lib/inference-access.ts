import { z } from "zod";
import type { ModelRef } from "../types";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, isAutoModel } from "@/react-app/domains/session/models/model-catalog";

export const desktopFreeAccessStatusSchema = z.object({
  state: z.enum(["ready", "update_required", "unavailable", "exhausted"]),
  code: z.string().nullable(),
  currentVersion: z.string(),
  minimumVersion: z.string().nullable(),
  providerID: z.string(),
  modelID: z.string(),
  allowance: z.object({ resetsAt: z.string(), limitUsd: z.number().finite().nonnegative(), usedUsd: z.number().finite().nonnegative(), reservedUsd: z.number().finite().nonnegative(), remainingUsd: z.number().finite().nonnegative() }).nullable(),
}).refine((status) => status.state !== "ready" || Boolean(status.minimumVersion?.trim() && status.allowance), "Ready Auto access requires a verified status");
export type DesktopFreeAccessStatus = z.infer<typeof desktopFreeAccessStatusSchema>;
export const autoAccessWallSchema = z.object({ state: z.enum(["limit", "update", "unavailable", "sync"]), resetsAt: z.string().optional(), minimumVersion: z.string().optional() });
export type AutoAccessWall = z.infer<typeof autoAccessWallSchema>;
export function messageAutoAccessWall(metadata: unknown) {
  const parsed = autoAccessWallSchema.safeParse(metadata && typeof metadata === "object" ? Reflect.get(metadata, "autoAccessWall") : null);
  return parsed.success ? parsed.data : null;
}
export type AutoAccessBlock = { outcome: "blocked"; reason: "auto-access"; wall: AutoAccessWall };
export class AutoAccessRejected extends Error {
  constructor(readonly wall: AutoAccessWall) { super("Auto access blocked"); }
}
export const autoAccessRefreshEvent = "openwork.auto-access-refresh";
export const openComposerModelPickerEvent = "openwork-open-composer-model-picker";

export function unavailableDesktopFreeStatus(): DesktopFreeAccessStatus {
  return { state: "unavailable", code: null, currentVersion: "", minimumVersion: null,
    providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, allowance: null };
}

export function autoAccessWall(status: DesktopFreeAccessStatus): AutoAccessWall | null {
  if (status.state === "ready") return null;
  return { state: status.state === "exhausted" ? "limit" : status.state === "update_required" ? "update" : "unavailable",
    resetsAt: status.allowance?.resetsAt, minimumVersion: status.minimumVersion ?? undefined };
}

export function autoAccessWallFromError(value: unknown, model?: ModelRef | null, depth = 0): AutoAccessWall | null {
  if ((model && !isAutoModel(model)) || depth > 6 || value == null) return null;
  if (typeof value === "string") {
    if (value.length > 65_536 || !value.trimStart().startsWith("{")) return null;
    try { return autoAccessWallFromError(JSON.parse(value), model, depth + 1); } catch { return null; }
  }
  if (typeof value !== "object") return null;
  const parsed = desktopFreeAccessStatusSchema.safeParse(value);
  if (parsed.success) return autoAccessWall(parsed.data);
  const code = Reflect.get(value, "code");
  if (code === "desktop_update_required") return { state: "update" };
  if (["anonymous_limit_exceeded", "anonymous_reservation_does_not_fit", "free_allowance_exhausted"].includes(code)) return { state: "limit" };
  if (["desktop_version_unavailable", "anonymous_capacity_exceeded", "anonymous_unavailable"].includes(code)) return { state: "unavailable" };
  if (code === "model_sync_pending") return { state: "sync" };
  for (const key of ["details", "error", "data", "responseBody", "message", "cause"]) {
    const wall = autoAccessWallFromError(Reflect.get(value, key), model, depth + 1);
    if (wall) return wall;
  }
  return null;
}

export async function preflightAutoSubmission(input: {
  model: ModelRef;
  client: { desktopFreePreflight: () => Promise<DesktopFreeAccessStatus> };
  isCurrent: () => boolean;
}): Promise<AutoAccessBlock | { outcome: "cancelled"; reason: "context_changed" } | null> {
  if (input.model.providerID !== AUTO_PROVIDER_ID || !isAutoModel(input.model)) return null;
  if (!input.isCurrent()) return { outcome: "cancelled", reason: "context_changed" };
  const status = await input.client.desktopFreePreflight().catch(() => unavailableDesktopFreeStatus());
  if (!input.isCurrent()) return { outcome: "cancelled", reason: "context_changed" };
  const wall = autoAccessWall(status);
  return wall ? { outcome: "blocked", reason: "auto-access", wall } : null;
}

export function autoWallCopy(wall: AutoAccessWall, signedIn: boolean) {
  switch (wall.state) {
    case "limit": return { title: "Your weekly free limit is used up", detail: signedIn ? "Your free allowance resets Monday. Switch to another model to continue." : "Your free allowance resets Monday. Sign in for a larger free allowance, or switch to another model." };
    case "update": return { title: "Update OpenWork to use Auto", detail: "Your message was not processed. Update the app or switch to another model." };
    case "sync": return { title: "Auto is still syncing", detail: "Your message was not processed. Wait for sync or switch to another model." };
    case "unavailable": return { title: "Auto is temporarily unavailable", detail: "Your message was not processed. Switch to another model or try again later." };
  }
}

export function openAlternativeModelPicker(sessionId: string) {
  window.dispatchEvent(new CustomEvent(openComposerModelPickerEvent, { detail: { sessionId, focusAlternative: true } }));
}
