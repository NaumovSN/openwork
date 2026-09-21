"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import type { FreeInferenceProviderSummary, ManagedModelRecommendation } from "@openwork/types/den/inference";
import type { GatewayModelGroup, GatewayModelScope } from "@openwork/types/den/gateway";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { DenBadge } from "../../_components/ui/badge";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getEditGatewayProviderRoute, getGatewayProvidersRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { saveInferenceProvider, useInferenceProvider, useOpenWorkFreeProvider, saveOpenWorkAutoPin } from "./inference-provider-data";
import { GatewayAccessMatrix } from "./inference-provider-matrix";
import { GatewayModelUniverse } from "./inference-provider-model-universe";
import { getFreeInferenceProviderLabel, gatewayModelScopeLabels, getSettingLabel, type DenInferenceProviderDetails } from "./inference-provider-request";
import { formatProviderTimestamp, getProviderIconSlug, requestLlmProviderCatalogDetail, type DenModelsDevProviderDetail } from "./llm-provider-data";

export const GATEWAY_EXPLAINER = "Members call this provider with their own AI Gateway key. Access rules select a model group and credential set; upstream credentials never reach their devices.";
const SECTION_CLASS = "mb-8 border-b border-gray-200 pb-8";

function ProviderModelUniverseEditor({ provider, reload }: { provider: DenInferenceProviderDetails; reload: () => Promise<void> }) {
  const { orgId, runReauthableAction } = useOrgDashboard();
  const [catalog, setCatalog] = useState<DenModelsDevProviderDetail | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ allowAllModels: boolean; modelIds: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    void requestLlmProviderCatalogDetail(orgId, provider.providerId).then((detail) => {
      if (!cancelled) setCatalog(detail);
    }).catch(() => {
      if (!cancelled) setCatalogError("Could not load the provider catalog. Your model policy has not changed.");
    });
    return () => { cancelled = true; };
  }, [orgId, provider.providerId]);

  const savedModelIds = provider.modelIds ?? provider.catalogModels.map((model) => model.id);
  const savedAllowAll = provider.modelIds !== null && provider.modelIds.length === 0;
  // Catalog and matrix reloads can update the saved view, but never replace a draft.
  const value = draft ?? { allowAllModels: savedAllowAll, modelIds: savedModelIds };
  const dirty = value.allowAllModels !== savedAllowAll || (!value.allowAllModels && (
    value.modelIds.length !== savedModelIds.length || value.modelIds.some((id) => !savedModelIds.includes(id))
  ));

  async function save() {
    if (!dirty || saving) return;
    setError(null);
    if (!catalog) return setError("Wait for the provider catalog to load before saving.");
    if (!value.allowAllModels && !value.modelIds.length) return setError("Select at least one model, or turn on Allow all models.");
    setSaving(true);
    try {
      await runReauthableAction("save-inference-provider-model-universe", async () => {
        await saveInferenceProvider({ inferenceProviderId: provider.id, body: { modelIds: value.allowAllModels ? [] : value.modelIds } });
      });
      await reload();
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the model universe.");
    } finally { setSaving(false); }
  }

  return <section className={SECTION_CLASS}>
    <GatewayModelUniverse
      models={catalog?.models ?? null}
      allowAllModels={value.allowAllModels}
      modelIds={value.modelIds}
      disabled={saving}
      warning={provider.catalogWarning}
      onChange={(allowAllModels, modelIds) => { setDraft({ allowAllModels, modelIds }); setError(null); }}
    />
    {catalogError ? <DenNotice className="mt-4" tone="error" message={catalogError} /> : null}
    {error ? <DenNotice className="mt-4" tone="error" message={error} /> : null}
    {dirty ? <div className="mt-5 flex flex-wrap items-center gap-3">
      <DenButton loading={saving} disabled={!catalog} onClick={() => void save()}>Save model universe</DenButton>
      <DenButton variant="secondary" disabled={saving} onClick={() => { setDraft(null); setError(null); }}>Cancel</DenButton>
      <span className="text-sm text-gray-500">Unsaved changes</span>
    </div> : null}
  </section>;
}

export function GatewayPinnedModelsTable({ models, pinnedModelIds, modelGroups, modelScopes, onChange, canManage = false, disabled = false }: {
  models: DenInferenceProviderDetails["catalogModels"];
  pinnedModelIds: string[];
  modelGroups?: GatewayModelGroup[];
  modelScopes?: GatewayModelScope[];
  onChange: (ids: string[]) => void;
  canManage?: boolean;
  disabled?: boolean;
}) {
  const readOnly = disabled || !canManage;
  const [selectedModelId, setSelectedModelId] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const available = models.filter((model) => !pinnedModelIds.includes(model.id));
  const rows = pinnedModelIds.map((id, index) => ({ id, index, name: models.find((model) => model.id === id)?.name ?? "Unavailable model" }));

  function move(id: string, direction: number) {
    if (readOnly) return;
    const index = pinnedModelIds.indexOf(id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= pinnedModelIds.length) return;
    const next = [...pinnedModelIds];
    const [model] = next.splice(index, 1);
    if (!model) return;
    next.splice(destination, 0, model);
    onChange(next);
    setAnnouncement(`${rows.find((row) => row.id === id)?.name ?? "Model"} moved to position ${destination + 1} in the draft.`);
  }

  const columns: readonly DenTableColumn<typeof rows[number]>[] = [
    { key: "order", header: "Order", width: "48px", render: (row) => row.index + 1 },
    { key: "name", header: "Model", render: (row) => <div><p className="font-medium">{row.name}</p><p className="break-all font-mono text-xs text-gray-500">{row.id}</p></div> },
    { key: "group", header: "Model group", width: "160px", render: (row) => modelGroups ? modelGroups.filter((group) => group.modelIds.includes(row.id)).map((group) => group.name).join(", ") || "No model group" : "Groups not reported" },
    { key: "scope", header: "Who sees it", width: "180px", render: (row) => <ul className="space-y-1 text-sm">{modelScopes ? [...new Set(modelScopes.filter((scope) => scope.modelId === row.id).map((scope) => scope.modelGroupId))].map((id) => {
      const scopes = modelScopes.filter((scope) => scope.modelId === row.id && scope.modelGroupId === id);
      return <li key={id}>{scopes[0]?.modelGroupName}: {gatewayModelScopeLabels(scopes).join(", ")}</li>;
    }) : <li>Audience not reported</li>}{modelScopes && !modelScopes.some((scope) => scope.modelId === row.id) ? <li>No active audience</li> : null}</ul> },
    { key: "actions", header: "Actions", render: (row) => <div className="flex gap-2">
      <DenButton size="xs" variant="ghost" disabled={readOnly || row.index === 0} aria-label={`Move ${row.name} up`} onClick={() => move(row.id, -1)}><ArrowUp className="size-4" strokeWidth={1.5} aria-hidden="true" /></DenButton>
      <DenButton size="xs" variant="ghost" disabled={readOnly || row.index === rows.length - 1} aria-label={`Move ${row.name} down`} onClick={() => move(row.id, 1)}><ArrowDown className="size-4" strokeWidth={1.5} aria-hidden="true" /></DenButton>
      <DenButton size="xs" variant="ghost" disabled={readOnly} aria-label={`Unpin ${row.name}`} onClick={() => { if (!readOnly) onChange(pinnedModelIds.filter((id) => id !== row.id)); }}>Unpin</DenButton>
    </div> },
  ];

  return <div className="grid gap-4">
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    <DenTable headerTone="plain" columns={columns} rows={rows} getRowKey={(row) => row.id} emptyLabel="No organization pins. Add a model below." />
    <div className="flex flex-wrap items-center gap-3">
      <DenCombobox ariaLabel="Model to pin" value={selectedModelId} onChange={setSelectedModelId} disabled={readOnly || available.length === 0} options={available.map((model) => ({ value: model.id, label: model.name }))} placeholder="Choose a model" searchPlaceholder="Search models" emptyLabel="All available models are pinned" />
      <DenButton size="sm" variant="secondary" disabled={readOnly || !available.some((model) => model.id === selectedModelId)} onClick={() => {
        if (readOnly || !available.some((model) => model.id === selectedModelId)) return;
        onChange([...pinnedModelIds, selectedModelId]);
        setSelectedModelId("");
      }}>Pin model</DenButton>
    </div>
  </div>;
}

function ProviderPinnedModelsEditor({ provider, reload }: { provider: DenInferenceProviderDetails; reload: () => Promise<void> }) {
  const { runReauthableAction, orgContext } = useOrgDashboard();
  const canManage = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles).isAdmin;
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? provider.pinnedModelIds;
  const dirty = value.length !== provider.pinnedModelIds.length || value.some((id, index) => id !== provider.pinnedModelIds[index]);

  async function save() {
    if (!canManage || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await runReauthableAction("save-gateway-pinned-models", async () => {
        await saveInferenceProvider({ inferenceProviderId: provider.id, body: { pinnedModelIds: value } });
      });
      await reload();
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save pinned models. Try again.");
    } finally { setSaving(false); }
  }

  return <section className={SECTION_CLASS} aria-labelledby="gateway-pinned-models-title">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 id="gateway-pinned-models-title" className="text-xl font-semibold">Pinned for members</h2>
      <span className="text-sm text-gray-500">Organization pins</span>
    </div>
    <GatewayPinnedModelsTable models={provider.catalogModels} pinnedModelIds={value} modelGroups={provider.modelGroups} modelScopes={provider.modelScopes} canManage={canManage} disabled={saving} onChange={(ids) => { setDraft(ids); setError(null); }} />
    {!canManage ? <p className="mt-3 text-sm text-gray-500">Only owners and admins can change organization pins.</p> : null}
    {error ? <DenNotice className="mt-4" tone="error" message={error} /> : null}
    {dirty ? <div className="mt-5 flex flex-wrap items-center gap-3">
      <DenButton loading={saving} disabled={!canManage} onClick={() => void save()}>Save pins</DenButton>
      <DenButton variant="secondary" disabled={saving} onClick={() => { setDraft(null); setError(null); }}>Cancel</DenButton>
      <span role="status" className="text-sm text-gray-500">Unsaved changes</span>
    </div> : null}
  </section>;
}

export function ProviderDetailHeader({ name, providerId, status, children, action }: { name: string; providerId: string; status: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="my-8 flex flex-wrap items-center justify-between gap-4">
    <div className="flex min-w-0 items-center gap-4">
      <DenBrandMark name={name} simpleIconSlug={getProviderIconSlug(providerId)} className="size-11 rounded-xl" />
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold">{name}</h1><DenBadge tone="neutral">{status}</DenBadge></div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500"><span>{providerId}</span>{children}</div>
      </div>
    </div>{action}
  </div>;
}

export function OpenWorkModelAllowance({ provider }: { provider: FreeInferenceProviderSummary | null }) {
  if (!provider) return <p className="text-sm text-gray-500">Organization allowance not reported. Refresh to verify.</p>;
  const { allowance } = provider;
  const dollars = (value: number | null) => value === null ? "Not reported" : `$${value.toFixed(2)}`;
  return <div className="grid gap-4">
    <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div><dt className="text-gray-500">Weekly limit</dt><dd className="mt-1 text-lg font-semibold">{dollars(allowance.weeklyLimitUsd)}</dd><dd className="text-xs text-gray-500">Per member · resets {formatProviderTimestamp(allowance.resetsAt)}</dd></div>
      <div><dt className="text-gray-500">At limit this week</dt><dd className="mt-1 text-lg font-semibold">{allowance.exhaustedMembers === null ? "Not reported" : `${allowance.exhaustedMembers} of ${allowance.eligibleMembers}`}</dd><dd className="text-xs text-gray-500">Members who hit the weekly limit</dd></div>
      <div><dt className="text-gray-500">Recorded free usage</dt><dd className="mt-1 text-lg font-semibold">{dollars(allowance.usedUsd)}</dd></div>
      <div><dt className="text-gray-500">When the limit is reached</dt><dd className="mt-1 text-sm">Auto pauses until reset</dd><dd className="text-xs text-gray-500">Other Gateway providers keep working</dd></div>
    </dl>
    <details className="text-sm text-gray-500"><summary className="cursor-pointer">Allowance details</summary>
      <dl className="mt-3 grid gap-3 sm:grid-cols-3"><div><dt>Reserved</dt><dd>{dollars(allowance.reservedUsd)}</dd></div><div><dt>Retained usage</dt><dd>{dollars(allowance.retainedUsd)}</dd></div><div><dt>Recorded requests</dt><dd>{allowance.requestCount ?? "Not reported"}</dd></div></dl>
      <p className="mt-3">Usage includes only free requests attributed to this organization. Retained usage includes unconfirmed requests. Allowance limits are person-wide; paid usage is separate.</p>
    </details>
  </div>;
}

export function OpenWorkFreeProviderContent({ provider, canManage, onSetDefaultPinned }: {
  provider: FreeInferenceProviderSummary;
  canManage: boolean;
  onSetDefaultPinned: (value: boolean) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audience = !canManage ? "Members with access" : provider.allowance.eligibleMembers === 0 ? "No eligible members"
    : provider.allowance.eligibleMembers === provider.allowance.joinedMembers ? "All joined members" : `${provider.allowance.eligibleMembers} eligible members`;
  async function setPinned(value: boolean) {
    if (!canManage || saving) return;
    setSaving(true);
    setError(null);
    try { await onSetDefaultPinned(value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the Auto pin. Try again."); }
    finally { setSaving(false); }
  }
  const columns: readonly DenTableColumn<ManagedModelRecommendation>[] = [
    { key: "model", header: "Model", render: (model) => <div><p className="font-medium">{model.displayName}</p><p className="break-all font-mono text-xs text-gray-500">{model.modelID}</p></div> },
    { key: "group", header: "Model group", width: "160px", render: () => provider.modelGroup.name },
    { key: "scope", header: "Who sees it", width: "180px", render: () => audience },
    { key: "action", header: "Actions", render: (model) => <DenButton size="sm" variant="ghost" disabled={!canManage} loading={saving} aria-label={`Unpin ${model.displayName}`} onClick={() => void setPinned(false)}>Unpin</DenButton> },
  ];
  const groupColumns: readonly DenTableColumn<ManagedModelRecommendation>[] = [
    columns[0], { key: "provider", header: "Provider", render: (model) => model.providerName },
    { key: "access", header: "Access", render: () => getFreeInferenceProviderLabel(provider) },
  ];
  return <>
    <section className={SECTION_CLASS} aria-labelledby="free-pins-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 id="free-pins-title" className="text-base font-semibold">Pinned for members</h2></div>
      <p className="mb-3 text-sm text-gray-500">Auto is pinned for every member by default so new installs work before anyone signs in. Members can add their own pins; admins can unpin Auto here.</p>
      <DenTable headerTone="plain" columns={columns} rows={provider.defaultPinned ? provider.catalog : []} getRowKey={(model) => model.modelID} emptyLabel={provider.defaultPinned ? "Pinned model details were not reported." : "Auto is not pinned for members."} />
      {!provider.defaultPinned ? <DenButton className="mt-3" size="sm" disabled={!canManage || provider.catalog.length === 0} loading={saving} onClick={() => void setPinned(true)}>Pin Auto</DenButton> : null}
      {!canManage ? <p className="mt-3 text-sm text-gray-500">Only owners and admins can change organization pins.</p> : null}
      {error ? <DenNotice className="mt-3" tone="error" message={error} /> : null}
      <details className="mt-3 text-sm text-gray-500"><summary className="cursor-pointer">Pin policy</summary><p className="mt-2">Unpinning does not change model access or personal pins. Members who are signed out still see Auto; their limit is tracked per device until they sign in.</p></details>
    </section>
    <section className={SECTION_CLASS} aria-labelledby="free-model-groups-title">
      <h2 id="free-model-groups-title" className="mb-4 text-base font-semibold">Model groups</h2>
      <details className="group border-y border-gray-200" data-testid="free-model-group">
        <summary className="flex cursor-pointer list-none items-center gap-4 py-3">
          <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{provider.modelGroup.name}</h3><p className="mt-1 text-xs text-gray-500">{provider.catalog.length} model · {provider.defaultPinned ? provider.catalog.length : 0} pinned · weekly limit per member</p></div>
          <span className="text-sm">{audience}</span><span className="text-sm text-gray-500">{getFreeInferenceProviderLabel(provider)}</span><ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" strokeWidth={1.5} aria-hidden="true" />
        </summary>
        <div className="border-t border-gray-100 py-3"><DenTable headerTone="plain" columns={groupColumns} rows={provider.catalog} getRowKey={(model) => model.modelID} emptyLabel="No free models reported." /></div>
      </details>
    </section>
    {canManage ? <section className={SECTION_CLASS}><h2 className="mb-1 text-base font-semibold">Free allowance</h2><p className="mb-4 text-sm text-gray-500">What OpenWork covers for this organization. Members only see a notice once they reach the limit.</p><OpenWorkModelAllowance provider={provider} /></section> : null}
  </>;
}

export function OpenWorkModelsDetailScreen() {
  const { orgId, orgSlug, orgContext, runReauthableAction } = useOrgDashboard();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const hosted = runtimeConfigLoaded && runtimeConfig.orgMode === "multi_org";
  const canManage = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles).isAdmin;
  const { provider, busy, error, reload, updatePin } = useOpenWorkFreeProvider(hosted && canManage ? orgId : null);
  return <div className="mx-auto max-w-[944px] px-6 py-8 md:px-8">
    <Link href={getGatewayProvidersRoute(orgSlug)} className="text-sm text-gray-500">Back to AI Gateway</Link>
    <ProviderDetailHeader name="OpenWork Models" providerId="openwork" status={busy && !provider ? "Checking access" : getFreeInferenceProviderLabel(error ? null : provider)} action={<DenButton variant="secondary" disabled={!hosted || !canManage} loading={busy} onClick={() => void reload()}>Refresh</DenButton>}>
      <span>Free plan</span>{provider ? <span>1 model group</span> : null}<span>Managed by OpenWork</span>
    </ProviderDetailHeader>
    {!runtimeConfigLoaded || busy && !provider ? <div role="status" aria-label="Loading OpenWork Models" className="grid animate-pulse gap-4"><div className="h-10 rounded bg-gray-100" /><div className="h-24 rounded bg-gray-100" /></div> : !hosted ? <DenNotice tone="info" message="OpenWork Models is not available in this deployment." /> : !canManage ? <DenNotice tone="info" message="Only owners and admins can view organization allowance summaries." /> : <>
      {error ? <DenNotice className="mb-6" tone="error" message={error} /> : null}
      {provider ? <OpenWorkFreeProviderContent key={orgId} provider={provider} canManage={canManage} onSetDefaultPinned={async (value) => {
        if (!orgId || !canManage) return;
        await runReauthableAction("save-free-auto-pin", async () => { updatePin(await saveOpenWorkAutoPin(orgId, value)); });
        await reload();
      }} /> : <p className="text-sm text-gray-500">Organization provider details have not been verified. Refresh to try again.</p>}
    </>}
  </div>;
}

export function InferenceProviderDetailScreen({ inferenceProviderId }: { inferenceProviderId: string }) {
  return inferenceProviderId === "openwork" ? <OpenWorkModelsDetailScreen /> : <GatewayProviderDetailScreen inferenceProviderId={inferenceProviderId} />;
}

function GatewayProviderDetailScreen({ inferenceProviderId }: { inferenceProviderId: string }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const { provider, busy, error, reload } = useInferenceProvider(orgId, inferenceProviderId);
  if (!provider) return <div className="mx-auto max-w-[944px] px-6 py-8">{busy ? <div role="status" aria-label="Loading provider" className="grid animate-pulse gap-8"><div className="h-12 rounded bg-gray-100" /><div className="h-40 rounded bg-gray-100" /></div> : <DenNotice tone="error" message={error ?? "Provider not found."} />}</div>;
  return <div className="mx-auto max-w-[944px] px-6 py-8 md:px-8">
    <Link href={getGatewayProvidersRoute(orgSlug)} className="text-sm text-gray-500">Back to AI Gateway</Link>
    <ProviderDetailHeader name={provider.name} providerId={provider.providerId} status={provider.status} action={<Link href={getEditGatewayProviderRoute(orgSlug, provider.id)}><DenButton variant="secondary" data-testid="gateway-provider-edit">Edit provider</DenButton></Link>}>
      <span>{provider.credentialSets.filter((set) => set.configured).length} keys</span><span>{provider.modelGroups.length} model groups</span><span>Updated {formatProviderTimestamp(provider.updatedAt)}</span>
    </ProviderDetailHeader>
    {error ? <DenNotice className="mb-6" tone="error" message={error} /> : null}
    <ProviderPinnedModelsEditor key={`pins:${orgId}:${provider.id}`} provider={provider} reload={reload} />
    <GatewayAccessMatrix key={`access:${orgId}:${provider.id}`} provider={provider} reload={reload} />
    <details className="text-sm" key={`configuration:${orgId}:${provider.id}`}>
      <summary className="cursor-pointer font-medium">Provider configuration</summary>
      <p className="my-4 text-gray-500">{GATEWAY_EXPLAINER}</p>
      <dl className="my-4 grid gap-4 md:grid-cols-2">{Object.entries(provider.settings).map(([key, value]) => <div key={key}><dt className="text-gray-500">{getSettingLabel(key)}</dt><dd className="break-words">{value}</dd></div>)}</dl>
      <ProviderModelUniverseEditor key={`universe:${orgId}:${provider.id}`} provider={provider} reload={reload} />
    </details>
  </div>;
}
