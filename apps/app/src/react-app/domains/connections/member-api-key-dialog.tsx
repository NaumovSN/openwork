import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MemberApiKeyBridge, MemberApiKeyContext, MemberApiKeyFailure } from "@openwork/types/member-api-key";
import { readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

declare global {
  interface Window { __OPENWORK_MEMBER_API_KEY__?: MemberApiKeyBridge }
}

type Request = { generation: number; connectionId: string; replacing: boolean; finish: (connected: boolean) => void };
let requestGeneration = 0;
let request: Request | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** UI intent only. No credential is accepted by this API or its subscribers. */
export function openMemberApiKeyDialog(connectionId: string, options: { replacing?: boolean } = {}): Promise<boolean> {
  request?.finish(false);
  return new Promise((finish) => { request = { generation: ++requestGeneration, connectionId, replacing: options.replacing === true, finish }; notify(); });
}

const messages: Record<MemberApiKeyFailure["code"], string> = {
  unavailable: "Secure connection setup is unavailable. Check your sign-in and connection access, then reopen Connect.",
  invalid_input: "Enter only the raw key, without a prefix or spaces.",
  context_changed: "Your account or connection changed. This attempt is unconfirmed; reopen the connection to check its current status.",
  expired: "This secure prompt expired. Close it and open Connect again.",
  busy: "This prompt has already submitted a key. Close it and check the connection before trying again.",
  forbidden: "You no longer have permission to connect this account. Check your sign-in and access.",
  uncertain: "The last save is unconfirmed. Close this prompt and check the current connection status before trying again. A saved key may still be your previous credential.",
};

function Prompt({ target, close }: { target: Request; close: (connected: boolean) => void }) {
  const field = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const contextRef = useRef<MemberApiKeyContext | null>(null);
  const [context, setContext] = useState<MemberApiKeyContext | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hasValue, setHasValue] = useState(false);

  useEffect(() => {
    const run = ++generation.current;
    const initial = readDenSettings();
    const bridge = window.__OPENWORK_MEMBER_API_KEY__;
    const changed = () => {
      const next = readDenSettings();
      if (initial.baseUrl !== next.baseUrl || initial.apiBaseUrl !== next.apiBaseUrl
        || initial.activeOrgId !== next.activeOrgId || initial.authToken !== next.authToken) {
        if (field.current) field.current.value = "";
        close(false);
      }
    };
    window.addEventListener(denSettingsChangedEvent, changed);
    if (!bridge) { setError(messages.unavailable); setPending(false); }
    else void bridge.prepare(target.connectionId).then((result) => {
      if (generation.current !== run) {
        if (result.ok) void bridge.cancel(result.context.handle);
        return;
      }
      if (result.ok) { contextRef.current = result.context; setContext(result.context); }
      else setError(messages[result.code]);
      setPending(false);
    }).catch(() => { if (generation.current === run) { setError(messages.unavailable); setPending(false); } });
    return () => {
      generation.current++;
      window.removeEventListener(denSettingsChangedEvent, changed);
      if (field.current) field.current.value = "";
      const current = contextRef.current;
      if (current) void bridge?.cancel(current.handle).catch(() => undefined);
      contextRef.current = null;
    };
  }, [target, close]);

  const submit = async () => {
    const bridge = window.__OPENWORK_MEMBER_API_KEY__;
    if (!context || pending || !field.current || !bridge) return;
    const run = generation.current;
    // Uncontrolled masked input: no token in React state, form cache or events.
    let apiKey = field.current.value;
    field.current.value = "";
    setHasValue(false);
    if (!/^[\x21-\x7e]{1,8192}$/.test(apiKey)) { apiKey = ""; setError(messages.invalid_input); return; }
    setPending(true);
    setError(null);
    try {
      const response = bridge.submit(context.handle, apiKey);
      apiKey = "";
      const result = await response;
      if (generation.current !== run) return;
      if (result.ok) setSaved(true);
      else setError(messages[result.code]);
      // A handle is single-submit, including unsuccessful or uncertain attempts.
      setContext(null);
    } catch { if (generation.current === run) { setError(messages.uncertain); setContext(null); } }
    finally { apiKey = ""; if (generation.current === run) setPending(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open) close(saved); }}>
    <DialogContent data-testid="member-api-key-dialog" data-ph-no-capture="true">
      <DialogHeader>
        <DialogTitle>{saved ? "Key saved" : `${target.replacing ? "Replace" : "Add"} key for ${context?.connectionName ?? "your account"}`}</DialogTitle>
        <DialogDescription>Use your own key. Never paste it into chat. OpenWork uses it only for your requests.</DialogDescription>
      </DialogHeader>
      {saved ? <p role="status">You saved your key. You can replace it at any time.</p>
        : <FieldGroup>
          {context ? <Field data-disabled={pending}>
            <FieldLabel htmlFor="member-api-key-input">Personal access token or API key</FieldLabel>
            <Input ref={field} id="member-api-key-input" data-testid="member-api-key-input" type="password"
              autoComplete="off" spellCheck={false} maxLength={8192} disabled={pending}
              data-ph-no-capture="true" data-private="true" autoFocus
              onChange={(event) => setHasValue(event.currentTarget.value.length > 0)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} />
            <FieldDescription>Your key goes directly through the secure desktop bridge, not through the conversation.</FieldDescription>
          </Field> : null}
          {pending ? <p role="status">{context ? "Saving your key…" : "Checking your account and connection…"}</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </FieldGroup>}
      <DialogFooter>
        <Button variant="outline" onClick={() => close(saved)}>{saved ? "Done" : "Close"}</Button>
        {context && !saved ? <Button disabled={pending || !hasValue} onClick={() => void submit()}>Save key</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

const closePrompt = (connected: boolean) => {
  const current = request;
  request = null;
  notify();
  current?.finish(connected);
};

export function MemberApiKeyDialog() {
  const target = useSyncExternalStore(subscribe, () => request, () => null);
  return target ? <Prompt key={target.generation} target={target} close={closePrompt} /> : null;
}
