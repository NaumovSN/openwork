"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DenButton } from "../../_components/ui/button";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenNotice } from "../../_components/ui/notice";
import { getBillingRoute, getCustomLlmProvidersRoute, getGatewayProviderRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { getGatewayDashboardAccess } from "../_lib/gateway-dashboard-access";
import { useOpenWorkFreeProvider } from "./inference-provider-data";
import { OpenWorkModelAllowance } from "./inference-provider-detail-screen";
import { getFreeInferenceProviderLabel } from "./inference-provider-request";

export function InferenceScreen() {
  const router = useRouter();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const dashboard = useOrgDashboard();
  const gatewayAccess = getGatewayDashboardAccess(dashboard);
  const checking = gatewayAccess === "checking" || !runtimeConfigLoaded;
  const access = getOrgAccessFlags(
    dashboard.orgContext?.currentMember.role ?? "member",
    dashboard.orgContext?.currentMember.isOwner ?? false,
    dashboard.orgContext?.roles,
  );
  const redirect = !access.isAdmin ? "/dashboard"
    : runtimeConfig.orgMode === "single_org" ? getCustomLlmProvidersRoute(dashboard.orgSlug)
    : null;

  useEffect(() => {
    if (!checking && !dashboard.orgError && redirect) router.replace(redirect);
  }, [checking, dashboard.orgError, redirect, router]);

  if (dashboard.orgError && !checking) return <DenNotice tone="error" message={dashboard.orgError} />;
  if (checking || redirect) {
    return <div className="flex min-h-[320px] items-center justify-center px-6 text-sm text-gray-500" data-testid="models-access-state" data-access-state={checking ? "checking" : "denied"}>
      {checking ? "Checking workspace access..." : "Redirecting to your dashboard..."}
    </div>;
  }
  return <InferenceContent key={dashboard.orgId} />;
}

function InferenceContent() {
  const dashboard = useOrgDashboard();
  const { provider, busy, error, reload } = useOpenWorkFreeProvider(dashboard.orgId);
  const gatewayEnabled = getGatewayDashboardAccess(dashboard) === "enabled";
  return <div className="mx-auto grid w-full max-w-[960px] gap-6 px-4 py-8 sm:px-6 lg:px-8">
    <DenPageHeader title="Usage & billing" action={<DenButton variant="secondary" href={getBillingRoute(dashboard.orgSlug)}>Open billing</DenButton>} />
    {error ? <DenNotice tone="error" message={error} /> : null}
    <section className="border-b border-gray-200 pb-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Organization Free allowance</h2>
        <DenButton variant="secondary" loading={busy} onClick={() => void reload()}>Refresh</DenButton>
      </div>
      {busy && !provider ? <div role="status" aria-label="Loading allowance" className="h-24 animate-pulse rounded bg-gray-100" /> : <>
        <p className="mb-4 text-sm text-gray-500">{getFreeInferenceProviderLabel(error ? null : provider)}</p>
        <OpenWorkModelAllowance provider={provider} />
      </>}
    </section>
    {gatewayEnabled ? <Link href={getGatewayProviderRoute(dashboard.orgSlug, "openwork")} className="text-sm underline">Open OpenWork Models provider</Link> : null}
  </div>;
}
