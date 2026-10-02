"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { McpCredentialInput } from "./mcp-credential-input";
import { MEMBER_API_KEY_GRANT_HELP, MEMBER_API_KEY_MAX_LENGTH, validateMemberApiKey } from "./member-api-key";
import { memberApiKeySaveErrorMessage, useSaveMyMcpApiKey } from "./mcp-connections-data";

export type MemberApiKeyTarget = { id: string; name: string; replacing?: boolean };

export function MemberApiKeyDialog({ target, onClose, onSaved }: {
  target: MemberApiKeyTarget | null;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  const { orgId } = useOrgDashboard();
  const organizationId = orgId ?? null;
  const targetId = target?.id ?? null;
  const targetLifetime = useRef<{ connectionId: string; organizationId: string | null } | null>(
    targetId ? { connectionId: targetId, organizationId } : null,
  );
  if (!targetId) targetLifetime.current = null;
  else if (!targetLifetime.current || targetLifetime.current.connectionId !== targetId) {
    targetLifetime.current = { connectionId: targetId, organizationId };
  }
  const targetMatchesOrganization = Boolean(
    targetId
    && targetLifetime.current?.connectionId === targetId
    && targetLifetime.current.organizationId === organizationId,
  );
  const save = useSaveMyMcpApiKey(targetMatchesOrganization ? targetId : null);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dialogGeneration = useRef(0);
  const renderedTargetId = useRef(targetId);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  if (renderedTargetId.current !== targetId) {
    renderedTargetId.current = targetId;
    dialogGeneration.current += 1;
  }

  useEffect(() => {
    setApiKey("");
    setError(null);
    setSaved(false);
    if (targetId && !targetMatchesOrganization) onCloseRef.current();
  }, [organizationId, targetId, targetMatchesOrganization]);

  function close() {
    dialogGeneration.current += 1;
    save.cancel();
    setApiKey("");
    setError(null);
    setSaved(false);
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || !targetMatchesOrganization) return;
    const validationError = validateMemberApiKey(apiKey);
    if (validationError) {
      setError(validationError);
      return;
    }
    const rawApiKey = apiKey;
    const submissionGeneration = dialogGeneration.current + 1;
    dialogGeneration.current = submissionGeneration;
    setApiKey("");
    setError(null);
    const outcome = await save.save(rawApiKey).catch((cause: unknown) => {
      if (dialogGeneration.current === submissionGeneration) setError(memberApiKeySaveErrorMessage(cause));
      return null;
    });
    if (!outcome) return;
    if (dialogGeneration.current !== submissionGeneration || !save.isCurrentAttempt(outcome.attemptGeneration)) return;
    if (outcome.kind === "stale") return;
    if (outcome.kind === "failed" || outcome.kind === "uncertain") {
      setError(outcome.message);
      return;
    }
    setSaved(true);
    if (dialogGeneration.current !== submissionGeneration || !save.isCurrentAttempt(outcome.attemptGeneration)) return;
    try {
      await onSaved?.();
    } catch {
      // The key is already stored. A failed refresh must not recast that save as a failure.
    }
  }

  return (
    <Dialog.Root open={target !== null && targetMatchesOrganization} onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup
          data-testid="member-api-key-dialog"
          data-ph-no-capture
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-gray-100 bg-white p-5 outline-none"
        >
          <Dialog.Title className="text-[16px] font-semibold leading-6 text-gray-900">
            {saved ? `${target?.name ?? "Connection"}: key saved` : `${target?.replacing ? "Replace" : "Add"} key for ${target?.name ?? "connection"}`}
          </Dialog.Title>
          {!saved ? <Dialog.Description className="mt-1.5 text-[12px] leading-[18px] text-gray-500">{MEMBER_API_KEY_GRANT_HELP}</Dialog.Description> : null}
          {saved ? (
            <div className="mt-5 flex justify-end">
              <DenButton size="sm" onClick={close}>Done</DenButton>
            </div>
          ) : (
            <form className="mt-5 flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-gray-700">Personal access token or API key</span>
                <McpCredentialInput
                  kind="secret"
                  name="member-mcp-api-key"
                  aria-label={`${target?.name ?? "Connection"} key`}
                  autoComplete="off"
                  data-ph-no-capture
                  maxLength={MEMBER_API_KEY_MAX_LENGTH}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={save.isPending}
                  autoFocus
                />
              </label>
              {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Dialog.Close disabled={save.isPending} className={buttonVariants({ variant: "secondary", size: "sm" })}>Cancel</Dialog.Close>
                <DenButton type="submit" size="sm" loading={save.isPending} disabled={!apiKey}>Save key</DenButton>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
