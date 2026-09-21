import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { autoAccessRefreshEvent, autoWallCopy, openAlternativeModelPicker, type AutoAccessWall } from "@/app/lib/inference-access";
import { useWorkspaceMaybe } from "@/react-app/shell/workspace-provider";
import { useDenAuth } from "./den-auth-provider";
import { isDesktopRuntime } from "@/app/utils";
import { readDenSettings } from "@/app/lib/den";
import { toast } from "@/components/ui/sonner";
import { beginRejectedTurnRecovery, claimRejectedTurnRecovery, type RejectedTurnOwner } from "../session/sync/draft-store";
import { suspendRejectedQueueForSignIn } from "../session/sync/rejected-turn";

export function AutoRejectedTurnRecoveryBridge() {
  const auth = useDenAuth();
  useEffect(() => {
    const settings = readDenSettings();
    if (auth.status === "signed_in" && auth.verifiedIdentity && auth.verifiedIdentity.organizationId === settings.activeOrgId) {
      claimRejectedTurnRecovery(settings.baseUrl, auth.verifiedIdentity);
    }
  }, [auth.status, auth.verifiedIdentity]);
  return null;
}

function openAutoUpdate() {
  window.location.hash = "/settings/updates";
}

export function openAutoSignIn(recovery?: { owner: RejectedTurnOwner; id: string }) {
  if (recovery && !beginRejectedTurnRecovery(recovery.owner, recovery.id)) {
    toast.error("Your unsent message could not be prepared for sign-in. Copy it before continuing.");
    return;
  }
  if (recovery) suspendRejectedQueueForSignIn(recovery.owner);
  const workspace = window.location.hash.match(/^#(\/workspace\/[^/]+)/)?.[1] ?? "";
  window.location.hash = `${workspace}/settings/cloud-account`;
}

export function AutoAccessFooter(props: { available: boolean; syncing?: boolean }) {
  return props.available || props.syncing ? <AutoAccessFooterContent {...props} /> : null;
}

function AutoAccessFooterContent({ available, syncing = false }: { available: boolean; syncing?: boolean }) {
  const workspace = useWorkspaceMaybe();
  const auth = useDenAuth();
  const client = workspace?.openworkServerClient;
  const query = useQuery({
    queryKey: ["auto-access", client?.baseUrl, workspace?.workspaceId, auth.status, auth.verifiedIdentity],
    enabled: available && isDesktopRuntime() && Boolean(client),
    queryFn: () => client!.desktopFreeStatus(),
    retry: false,
    staleTime: 15_000,
  });
  useEffect(() => {
    if (!available || !client) return;
    const refresh = () => { void query.refetch(); };
    window.addEventListener(autoAccessRefreshEvent, refresh);
    return () => window.removeEventListener(autoAccessRefreshEvent, refresh);
  }, [available, client, query.refetch]);
  if (!available && !syncing) return null;
  const status = syncing || query.isFetching ? "Syncing Auto…"
    : query.isError || query.data?.state === "unavailable" ? "Auto status unavailable"
    : query.data?.state === "exhausted" ? "Free limit used up"
    : query.data?.state === "update_required" ? "Update required for Auto"
    : query.data?.state === "ready" ? "Free access ready" : "Auto";
  return <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
    <span role="status">{status}</span>
    {auth.status === "signed_out" ? <Button size="sm" variant="ghost" onClick={() => openAutoSignIn()}>Sign in to sync</Button> : null}
  </div>;
}

export function AutoAccessNotice({ wall, sessionId, workspaceId, recovery }: { wall: AutoAccessWall; sessionId: string; workspaceId?: string; recovery?: { owner: RejectedTurnOwner; id: string } }) {
  const auth = useDenAuth();
  const copy = autoWallCopy(wall, auth.isSignedIn);
  return <section role="status" data-testid="auto-access-wall" data-state={wall.state} className="rounded-lg border border-border px-4 py-3 text-sm">
    <p className="font-medium">{copy.title}</p>
    <p className="mt-1 text-muted-foreground">{copy.detail}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {wall.state === "update" ? <Button size="sm" onClick={openAutoUpdate}>Update OpenWork</Button>
        : wall.state === "limit" && auth.status === "signed_out" ? <Button size="sm" onClick={() => openAutoSignIn(recovery)}>Sign in for more free access</Button> : null}
      <Button size="sm" variant="ghost" onClick={() => openAlternativeModelPicker(sessionId)}>Switch model</Button>
    </div>
  </section>;
}
