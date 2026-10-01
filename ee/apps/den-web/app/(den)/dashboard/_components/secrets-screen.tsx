"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, Plus } from "lucide-react";
import {
  secretListSchema,
  type SecretList,
  type SecretValueStatus,
  type SecretDefinitionInput,
} from "@openwork/types/den/secrets";
import { requestJson, getRequestError } from "../../_lib/den-flow";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { DenSelect } from "../../_components/ui/select";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenPageHeader } from "../../_components/ui/page-header";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useMcpConnections } from "./mcp-connections-data";

type View = "mine" | "requirements" | "organization" | "connections";
async function secretRequest(
  orgId: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const { response, payload } = await requestJson(`/v1/org/secrets${path}`, {
    method,
    headers: { "x-openwork-org-id": orgId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw getRequestError(
      payload,
      response,
      "Couldn't save this change. Try again.",
    );
  return payload;
}
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Couldn't save this change. Try again.";
const fieldClass = "grid gap-1.5 text-[13px] text-[var(--dls-text-primary)]";

export function SecretsScreen() {
  const { orgId } = useOrgDashboard();
  return orgId ? <SecretsWorkspace key={orgId} orgId={orgId} /> : null;
}

function SecretsWorkspace({ orgId }: { orgId: string }) {
  const client = useQueryClient();
  const key = ["secrets-and-variables", orgId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => secretListSchema.parse(await secretRequest(orgId, "")),
    refetchOnWindowFocus: true,
  });
  const [view, setView] = useState<View>("mine");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function mutate(
    path: string,
    method: string,
    body: unknown,
    outcome: string,
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await secretRequest(orgId, path, method, body);
      await client.invalidateQueries({ queryKey: key });
      setNotice(
        path.endsWith("/check") &&
          result &&
          typeof result === "object" &&
          "toolCount" in result
          ? `Connection checked. ${result.toolCount} tools available.`
          : outcome,
      );
    } catch (caught) {
      setError(message(caught));
      throw caught;
    } finally {
      setBusy(false);
    }
  }
  const data = query.data;
  const rows =
    data?.definitions.filter((definition) =>
      view === "organization"
        ? definition.source === "organization"
        : definition.source === "member",
    ) ?? [];
  return (
    <div
      className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8"
      data-testid="secrets-screen"
    >
      <DenPageHeader
        title="Secrets and variables"
        size="compact"
        action={
          data?.canManage &&
          (view === "requirements" || view === "organization") ? (
            <DenButton size="sm" onClick={() => setAdding(!adding)}>
              <Plus size={14} />
              {view === "organization"
                ? "Add organization value"
                : "Add requirement"}
            </DenButton>
          ) : undefined
        }
      />
      {data?.canManage ? (
        <DenSegmented<View>
          aria-label="Secrets view"
          value={view}
          onChange={(next) => {
            setView(next);
            setAdding(false);
            setNotice(null);
            setError(null);
          }}
          options={[
            { value: "mine", label: "My values" },
            { value: "requirements", label: "Member requirements" },
            { value: "organization", label: "Organization values" },
            { value: "connections", label: "Connection templates" },
          ]}
        />
      ) : null}
      {notice ? (
        <div role="status" className="text-[13px]" data-testid="secrets-saved">
          {notice}
        </div>
      ) : null}
      {error || query.error ? (
        <div role="alert" className="text-[13px] text-[var(--destructive)]">
          {error ?? message(query.error)}{" "}
          <DenButton
            variant="ghost"
            size="xs"
            onClick={() => void query.refetch()}
          >
            Refresh
          </DenButton>
        </div>
      ) : null}
      {query.isPending ? (
        <div className="space-y-3" aria-label="Loading values">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="h-12 animate-pulse rounded bg-[var(--muted)]"
            />
          ))}
        </div>
      ) : null}
      {adding && data?.canManage ? (
        <DefinitionForm
          source={view === "organization" ? "organization" : "member"}
          busy={busy}
          save={async (definition) => {
            await mutate(
              "/definitions",
              "POST",
              definition,
              "Definition added.",
            );
            setAdding(false);
          }}
          cancel={() => setAdding(false)}
        />
      ) : null}
      {data && view !== "connections" ? (
        <div>
          {rows.length === 0 ? (
            <p className="py-10 text-[13px] text-[var(--muted-foreground)]">
              {view === "mine"
                ? "Your workspace has no member values to fill in."
                : "No values defined yet."}
            </p>
          ) : (
            rows.map((definition) =>
              view === "requirements" ? (
                <RequirementRow
                  key={definition.id}
                  definition={definition}
                  busy={busy}
                  save={(input) =>
                    mutate(
                      `/definitions/${definition.id}`,
                      "PATCH",
                      input,
                      "Requirement saved.",
                    )
                  }
                />
              ) : (
                <ValueRow
                  key={definition.id}
                  definition={definition}
                  busy={busy}
                  save={(value) =>
                    mutate(
                      `/values/${definition.id}`,
                      "PUT",
                      { value, expectedRevision: definition.valueRevision },
                      "Value saved.",
                    )
                  }
                  clear={() =>
                    mutate(
                      `/values/${definition.id}`,
                      "DELETE",
                      { expectedRevision: definition.valueRevision },
                      "Value cleared.",
                    )
                  }
                />
              ),
            )
          )}
        </div>
      ) : null}
      {data && view === "connections" && data.canManage ? (
        <ConnectionTemplates
          data={data}
          busy={busy}
          save={(id, body) =>
            mutate(
              `/connections/${id}`,
              "PUT",
              body,
              "Connection templates saved. Members review their destination before use.",
            )
          }
        />
      ) : null}
      {data && view === "mine" ? (
        <div className="space-y-2">
          {data.bindings.length ? (
            <h2 className="pt-4 text-[14px] font-semibold">
              Connections using your values
            </h2>
          ) : null}
          {data.bindings.map((binding) => (
            <div
              key={binding.connectionId}
              className="border-b border-[var(--border)] py-4"
              data-testid={`secret-binding-${binding.connectionId}`}
            >
              <div className="flex items-center justify-between gap-4">
                <span className="text-[13px] font-medium">
                  {binding.connectionName}
                </span>
                <span className="text-[12px] text-[var(--muted-foreground)]">
                  {binding.ready ? "Ready" : "Action needed"}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-[var(--muted-foreground)]">
                {binding.endpoint}
              </p>
              <DenButton
                size="sm"
                variant="secondary"
                disabled={busy || !binding.ready}
                data-testid={`check-secret-${binding.connectionId}`}
                onClick={() =>
                  void mutate(
                    `/connections/${binding.connectionId}/check`,
                    "POST",
                    {},
                    "Connection checked.",
                  ).catch(() => {})
                }
              >
                Check connection
              </DenButton>
              {binding.missingLabels.length ? (
                <p className="mt-2 text-[13px]">
                  Add {binding.missingLabels.join(", ")} above.
                </p>
              ) : null}
              {binding.needsAdmin ? (
                <p className="mt-2 text-[13px]">
                  A workspace admin needs to update this connection.
                </p>
              ) : !binding.approved ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[13px]">
                    Allow {binding.connectionName} to send{" "}
                    {binding.labels.join(", ")} to this destination.
                  </span>
                  <DenButton
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        `/connections/${binding.connectionId}/approve`,
                        "POST",
                        { revision: binding.revision },
                        "Credential destination approved.",
                      ).catch(() => {})
                    }
                    data-testid={`approve-secret-${binding.connectionId}`}
                  >
                    Approve destination
                  </DenButton>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DefinitionForm({
  source,
  busy,
  save,
  cancel,
}: {
  source: "member" | "organization";
  busy: boolean;
  save: (input: SecretDefinitionInput) => Promise<void>;
  cancel: () => void;
}) {
  const [kind, setKind] = useState<"secret" | "variable">("secret");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [helpText, setHelpText] = useState("");
  const [required, setRequired] = useState(source === "member");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await save({ name, label, helpText, kind, source, required });
    } catch {}
  }
  return (
    <form
      onSubmit={submit}
      className="grid gap-4 border-b border-[var(--border)] py-5"
      aria-label="Add definition"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={fieldClass}>
          Name
          <DenInput
            required
            pattern="[A-Z][A-Z0-9_]{0,63}"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="WORK_TOKEN"
            autoComplete="off"
          />
        </label>
        <label className={fieldClass}>
          Label
          <DenInput
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Work account token"
          />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={fieldClass}>
          Type
          <DenSelect
            value={kind}
            onChange={(event) => {
              if (
                event.target.value === "secret" ||
                event.target.value === "variable"
              )
                setKind(event.target.value);
            }}
          >
            <option value="secret">Secret</option>
            <option value="variable">Variable</option>
          </DenSelect>
        </label>
        <label className={fieldClass}>
          Help text
          <DenInput
            value={helpText}
            onChange={(event) => setHelpText(event.target.value)}
            placeholder="Where to get this value"
          />
        </label>
      </div>
      {source === "member" ? (
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
          />
          Required for every member
        </label>
      ) : null}
      <div className="flex gap-2">
        <DenButton type="submit" size="sm" disabled={busy}>
          Add definition
        </DenButton>
        <DenButton type="button" variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </DenButton>
      </div>
    </form>
  );
}

function RequirementRow({
  definition,
  busy,
  save,
}: {
  definition: SecretValueStatus;
  busy: boolean;
  save: (input: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(definition.label);
  const [helpText, setHelpText] = useState(definition.helpText);
  const [required, setRequired] = useState(definition.required);
  return (
    <div
      className="border-b border-[var(--border)] py-4"
      data-testid={`requirement-${definition.name}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[13px] font-medium">{definition.label}</p>
          <p className="mt-1 text-[12px] text-[var(--muted-foreground)]">
            {definition.name} ·{" "}
            {definition.kind === "secret" ? "Secret" : "Variable"} ·{" "}
            {definition.required ? "Required" : "Optional"} ·{" "}
            {definition.completionCount ?? 0} members filled in
          </p>
        </div>
        <DenButton
          variant="ghost"
          size="sm"
          onClick={() => setEditing(!editing)}
          data-testid={`edit-requirement-${definition.name}`}
        >
          Edit requirement
        </DenButton>
      </div>
      {editing ? (
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save({
              label,
              helpText,
              required,
              expectedRevision: definition.revision,
            })
              .then(() => setEditing(false))
              .catch(() => {});
          }}
        >
          <label className={fieldClass}>
            Label
            <DenInput
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              required
            />
          </label>
          <label className={fieldClass}>
            Help text
            <DenInput
              value={helpText}
              onChange={(event) => setHelpText(event.target.value)}
            />
          </label>
          <label className="flex gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={required}
              onChange={(event) => setRequired(event.target.checked)}
            />
            Required for every member
          </label>
          <div>
            <DenButton size="sm" disabled={busy}>
              Save requirement
            </DenButton>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ValueRow({
  definition,
  busy,
  save,
  clear,
}: {
  definition: SecretValueStatus;
  busy: boolean;
  save: (value: string) => Promise<void>;
  clear: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const submitted = value;
    setValue("");
    try {
      await save(submitted);
      setEditing(false);
    } catch {}
  }
  return (
    <div
      className="border-b border-[var(--border)] py-4"
      data-testid={`secret-value-${definition.name}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[13px] font-medium">
            {definition.kind === "secret" ? (
              <LockKeyhole size={14} aria-label="Write-only secret" />
            ) : null}
            {definition.label}
            {definition.required ? (
              <span className="text-[11px] font-normal text-[var(--muted-foreground)]">
                Required
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[12px] text-[var(--muted-foreground)]">
            {definition.kind === "variable" && definition.saved
              ? definition.variableValue
              : definition.saved
                ? "Saved"
                : "Not provided"}
            {definition.helpText ? ` · ${definition.helpText}` : ""}
          </p>
        </div>
        <DenButton
          size="sm"
          variant="secondary"
          data-testid={`edit-value-${definition.name}`}
          onClick={() => {
            setValue(
              definition.kind === "variable"
                ? (definition.variableValue ?? "")
                : "",
            );
            setEditing(!editing);
          }}
        >
          {definition.saved ? "Replace value" : "Add value"}
        </DenButton>
      </div>
      {editing ? (
        <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2">
          <label className={`${fieldClass} min-w-64 flex-1`}>
            New value
            <DenInput
              type={definition.kind === "secret" ? "password" : "text"}
              autoComplete="new-password"
              data-testid={`input-value-${definition.name}`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required={definition.kind === "secret"}
              maxLength={4096}
            />
          </label>
          <DenButton
            size="sm"
            data-testid={`save-value-${definition.name}`}
            disabled={busy}
          >
            Save value
          </DenButton>
          <DenButton
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setValue("");
              setEditing(false);
            }}
          >
            Cancel
          </DenButton>
          {definition.saved ? (
            <DenButton
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`clear-value-${definition.name}`}
              onClick={() => setConfirmClear(true)}
            >
              Clear value
            </DenButton>
          ) : null}
        </form>
      ) : null}
      {confirmClear ? (
        <div
          className="mt-3 flex items-center justify-between gap-3 text-[13px]"
          role="alert"
        >
          <span>
            Clear {definition.label}? Connections using it will need a new
            value.
          </span>
          <div className="flex gap-2">
            <DenButton
              size="sm"
              variant="destructive"
              disabled={busy}
              data-testid={`confirm-clear-${definition.name}`}
              onClick={() =>
                void clear()
                  .then(() => {
                    setConfirmClear(false);
                    setEditing(false);
                    setValue("");
                  })
                  .catch(() => {})
              }
            >
              Clear saved value
            </DenButton>
            <DenButton
              size="sm"
              variant="ghost"
              onClick={() => setConfirmClear(false)}
            >
              Keep value
            </DenButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionTemplates({
  data,
  busy,
  save,
}: {
  data: SecretList;
  busy: boolean;
  save: (id: string, input: unknown) => Promise<void>;
}) {
  const connections = useMcpConnections("manageable");
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const binding = data.bindings.find((item) => item.connectionId === selected);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const headers: Array<{ name: string; template: string }> = [];
    for (const line of text.split("\n").filter((line) => line.trim())) {
      const split = line.indexOf(":");
      if (split < 1) {
        setError(
          "Use one header per line, such as Authorization: Bearer {!WORK_TOKEN}.",
        );
        return;
      }
      headers.push({
        name: line.slice(0, split).trim(),
        template: line.slice(split + 1).trim(),
      });
    }
    try {
      await save(selected, {
        headers,
        expectedRevision: binding?.revision ?? 0,
      });
    } catch {}
  }
  return (
    <form
      onSubmit={submit}
      className="grid gap-4"
      aria-label="Connection templates"
    >
      <label className={fieldClass}>
        Connection
        <DenSelect
          value={selected}
          onChange={(event) => {
            const id = event.target.value;
            setSelected(id);
            setText(
              data.bindings
                .find((item) => item.connectionId === id)
                ?.headers.map((header) => `${header.name}: ${header.template}`)
                .join("\n") ?? "",
            );
          }}
        >
          <option value="">Choose a connection</option>
          {connections.data
            ?.filter((connection) => !connection.nativeProviderKey)
            .map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
        </DenSelect>
      </label>
      <label className={fieldClass}>
        HTTP headers
        <DenTextarea
          rows={5}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={
            "Authorization: Bearer {!WORK_TOKEN}\nX-Workspace: {!WORKSPACE_ID}"
          }
        />
      </label>
      <p className="text-[12px] text-[var(--muted-foreground)]">
        References are filled on the server when a member uses this connection.
        Choose per-person authentication for member values.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <div>
        <DenButton size="sm" disabled={busy || !selected}>
          Save templates
        </DenButton>
      </div>
    </form>
  );
}
