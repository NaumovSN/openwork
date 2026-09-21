"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { InferenceAccess, ManagedModelRecommendation } from "@openwork/types/den/inference";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getEditGatewayProviderRoute, getGatewayProvidersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { saveInferenceProvider, useInferenceProvider, useOpenWorkModelAccess } from "./inference-provider-data";
import { GatewayAccessMatrix } from "./inference-provider-matrix";
import { GatewayModelUniverse } from "./inference-provider-model-universe";
import { getOpenWorkModelAccessLabel, getSettingLabel, type DenInferenceProviderDetails } from "./inference-provider-request";
import { formatProviderTimestamp, requestLlmProviderCatalogDetail, type DenModelsDevProviderDetail } from "./llm-provider-data";

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

export function GatewayPinnedModelsTable({ models, pinnedModelIds, onChange, disabled = false }: {
  models: DenInferenceProviderDetails["catalogModels"];
  pinnedModelIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [selectedModelId, setSelectedModelId] = useState("");
  const available = models.filter((model) => !pinnedModelIds.includes(model.id));
  const rows = pinnedModelIds.map((id, index) => ({ id, index, name: models.find((model) => model.id === id)?.name ?? "Unavailable model" }));

  function move(id: string, direction: number) {
    const index = pinnedModelIds.indexOf(id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= pinnedModelIds.length) return;
    const next = [...pinnedModelIds];
    const [model] = next.splice(index, 1);
    if (!model) return;
    next.splice(destination, 0, model);
    onChange(next);
  }

  const columns: readonly DenTableColumn<typeof rows[number]>[] = [
    { key: "order", header: "Order", render: (row) => row.index + 1 },
    { key: "name", header: "Model", render: (row) => <span className="font-medium">{row.name}</span> },
    { key: "scope", header: "Scope", render: () => "Members with access" },
    { key: "actions", header: "Actions", render: (row) => <div className="flex gap-2">
      <DenButton size="sm" variant="secondary" disabled={disabled || row.index === 0} aria-label={`Move ${row.name} up`} onClick={() => move(row.id, -1)}><ArrowUp className="size-4" strokeWidth={1.5} aria-hidden="true" /></DenButton>
      <DenButton size="sm" variant="secondary" disabled={disabled || row.index === rows.length - 1} aria-label={`Move ${row.name} down`} onClick={() => move(row.id, 1)}><ArrowDown className="size-4" strokeWidth={1.5} aria-hidden="true" /></DenButton>
      <DenButton size="sm" variant="secondary" disabled={disabled} aria-label={`Unpin ${row.name}`} onClick={() => onChange(pinnedModelIds.filter((id) => id !== row.id))}>Unpin</DenButton>
    </div> },
  ];

  return <div className="grid gap-4">
    <DenTable headerTone="plain" columns={columns} rows={rows} getRowKey={(row) => row.id} emptyLabel="No organization pins. Add a model below." />
    <div className="flex flex-wrap items-center gap-3">
      <DenCombobox ariaLabel="Model to pin" value={selectedModelId} onChange={setSelectedModelId} disabled={disabled || available.length === 0} options={available.map((model) => ({ value: model.id, label: model.name }))} placeholder="Choose a model" searchPlaceholder="Search models" emptyLabel="All available models are pinned" />
      <DenButton size="sm" variant="secondary" disabled={disabled || !available.some((model) => model.id === selectedModelId)} onClick={() => {
        if (!available.some((model) => model.id === selectedModelId)) return;
        onChange([...pinnedModelIds, selectedModelId]);
        setSelectedModelId("");
      }}>Pin model</DenButton>
    </div>
  </div>;
}

function ProviderPinnedModelsEditor({ provider, reload }: { provider: DenInferenceProviderDetails; reload: () => Promise<void> }) {
  const { runReauthableAction } = useOrgDashboard();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? provider.pinnedModelIds;
  const dirty = value.length !== provider.pinnedModelIds.length || value.some((id, index) => id !== provider.pinnedModelIds[index]);

  async function save() {
    if (!dirty || saving) return;
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
    <GatewayPinnedModelsTable models={provider.catalogModels} pinnedModelIds={value} disabled={saving} onChange={(ids) => { setDraft(ids); setError(null); }} />
    {error ? <DenNotice className="mt-4" tone="error" message={error} /> : null}
    {dirty ? <div className="mt-5 flex flex-wrap items-center gap-3">
      <DenButton loading={saving} onClick={() => void save()}>Save pins</DenButton>
      <DenButton variant="secondary" disabled={saving} onClick={() => { setDraft(null); setError(null); }}>Cancel</DenButton>
      <span role="status" className="text-sm text-gray-500">Unsaved changes</span>
    </div> : null}
  </section>;
}

export function OpenWorkModelAllowance({ access }: { access: InferenceAccess | null }) {
  if (!access) return <p className="text-sm text-gray-500">Allowance unavailable. Refresh to verify access.</p>;
  const dollars = (value: number | null) => value === null ? "Not reported" : `$${value.toFixed(2)}`;
  const resetsAt = access.resetsAt && !Number.isNaN(Date.parse(access.resetsAt)) ? formatProviderTimestamp(access.resetsAt) : "Not reported";
  return <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
    <div><dt className="text-gray-500">Weekly allowance</dt><dd>{dollars(access.weeklyLimitUsd)}</dd></div>
    <div><dt className="text-gray-500">Used</dt><dd>{dollars(access.usedUsd)}</dd></div>
    <div><dt className="text-gray-500">Remaining</dt><dd>{dollars(access.remainingUsd)}</dd></div>
    <div><dt className="text-gray-500">Resets</dt><dd>{resetsAt}</dd></div>
  </dl>;
}

export function OpenWorkModelsDetailScreen() {
  const { orgId, orgSlug } = useOrgDashboard();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const hosted = runtimeConfigLoaded && runtimeConfig.orgMode === "multi_org";
  const { access, busy, error, reload } = useOpenWorkModelAccess(hosted ? orgId : null);
  const columns: readonly DenTableColumn<ManagedModelRecommendation>[] = [
    { key: "model", header: "Model", render: (model) => <span className="font-medium">{model.displayName}</span> },
    { key: "provider", header: "Provider", render: (model) => model.providerName },
    { key: "access", header: "Access", render: () => getOpenWorkModelAccessLabel(error ? null : access) },
  ];
  return <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
    <Link href={getGatewayProvidersRoute(orgSlug)} className="text-sm text-gray-500">Back to AI Gateway</Link>
    <div className="my-8 flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-xl font-semibold">OpenWork Models</h1>
      <DenButton variant="secondary" disabled={!hosted} loading={busy} onClick={() => void reload()}>Refresh</DenButton>
    </div>
    {!runtimeConfigLoaded || busy && !access ? <div role="status" aria-label="Loading OpenWork Models" className="grid animate-pulse gap-4"><div className="h-10 rounded bg-gray-100" /><div className="h-24 rounded bg-gray-100" /></div> : !hosted ? <DenNotice tone="info" message="OpenWork Models is not available in this deployment." /> : <>
      {error ? <DenNotice className="mb-6" tone="error" message={error} /> : null}
      <section className={SECTION_CLASS}>
        <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">Provider</h2><DenBadge tone="neutral">{getOpenWorkModelAccessLabel(error ? null : access)}</DenBadge></div>
        <p className="text-sm text-gray-500">Managed by OpenWork</p>
      </section>
      <section className={SECTION_CLASS}>
        <h2 className="mb-4 text-xl font-semibold">Models</h2>
        <DenTable headerTone="plain" columns={columns} rows={access?.catalog ?? []} getRowKey={(model) => model.modelID} emptyLabel="Model catalog unavailable from this server." />
      </section>
      <section className={SECTION_CLASS}><h2 className="mb-4 text-xl font-semibold">Your allowance</h2><OpenWorkModelAllowance access={access} /></section>
    </>}
  </div>;
}

export function InferenceProviderDetailScreen({ inferenceProviderId }: { inferenceProviderId: string }) {
  return inferenceProviderId === "openwork" ? <OpenWorkModelsDetailScreen /> : <GatewayProviderDetailScreen inferenceProviderId={inferenceProviderId} />;
}

function GatewayProviderDetailScreen({ inferenceProviderId }: { inferenceProviderId: string }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const { provider, busy, error, reload } = useInferenceProvider(orgId, inferenceProviderId);
  if (!provider) return <div className="p-8">{busy ? "Loading provider..." : <DenNotice tone="error" message={error ?? "Provider not found."} />}</div>;
  return <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
    <Link href={getGatewayProvidersRoute(orgSlug)} className="text-sm text-gray-500">Back to AI Gateway</Link>
    <div className="my-8 flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-3xl font-semibold">{provider.name}</h1>
      <Link href={getEditGatewayProviderRoute(orgSlug, provider.id)}><DenButton variant="secondary" data-testid="gateway-provider-edit">Edit provider and models</DenButton></Link>
    </div>
    <p className="mb-8 text-gray-500">{GATEWAY_EXPLAINER}</p>
    <section className={SECTION_CLASS}>
      <h2 className="mb-4 text-xl font-semibold">Provider</h2>
      <div className="flex flex-wrap gap-3"><span>{provider.providerId}</span><DenBadge tone={provider.status === "active" ? "success" : "neutral"}>{provider.status}</DenBadge><span className="text-gray-500">Updated {formatProviderTimestamp(provider.updatedAt)}</span></div>
      <dl className="mt-4 grid gap-4 md:grid-cols-2">{Object.entries(provider.settings).map(([key, value]) => <div key={key}><dt className="text-sm text-gray-500">{getSettingLabel(key)}</dt><dd className="break-words">{value}</dd></div>)}</dl>
    </section>
    <ProviderModelUniverseEditor key={`universe:${orgId}:${provider.id}`} provider={provider} reload={reload} />
    <ProviderPinnedModelsEditor key={`pins:${orgId}:${provider.id}`} provider={provider} reload={reload} />
    <GatewayAccessMatrix key={`access:${orgId}:${provider.id}`} provider={provider} reload={reload} />
  </div>;
}
