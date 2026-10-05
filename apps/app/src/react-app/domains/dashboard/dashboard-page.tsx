/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Blocks } from "lucide-react";

import { createDenClient, readDenSettings, type DenGrantedDashboard } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Skeleton } from "@/components/ui/skeleton";
import { CloudSignInBanner, CloudSignInBannerIcon } from "@/react-app/domains/cloud/cloud-sign-in-banner";
import { t } from "../../../i18n";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { dashboardTileCacheScopeKey } from "./dashboard-tile-cache";
import {
  grantedConsentScopeKey,
  grantedDashboardEntry,
  grantedEntryId,
  readGrantedConsent,
  writeGrantedConsent,
  type GrantedConsentMap,
} from "./granted-dashboard-store";
import { McpAppTile, type DashboardLaunchEndpoint } from "./mcp-app-tile";
import { DashboardApps, type CreateDashboardApp } from "./dashboard-apps";
import { useSavedApps } from "../apps/use-apps";
import { DashboardMasonry } from "./dashboard-masonry";

/**
 * Personal apps alongside the dashboards shared by the organization.
 * Company definitions stay in Den; personal placement belongs to each member.
 */
export function DashboardPage({ fallbackEndpoints, onCreateApp, headerActionsTarget, onSignIn }: {
  onCreateApp: CreateDashboardApp;
  /** Opens OpenWork Cloud sign-in, the same action Library offers when signed out. */
  onSignIn?: () => void;
  /** Titlebar slot for the Add control, matching Library. */
  headerActionsTarget?: HTMLElement | null;
  /** Other workspace MCP runtimes tiles may launch through when the primary one lacks their server. */
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const denAuth = useDenAuth();
  const personal = useSavedApps();
  // The active org lives in den settings, which change outside React; track
  // them through the settings-changed event so an org switch swaps the board
  // scope and the granted-dashboard fetch together.
  const [denSettings, setDenSettings] = useState(() => readDenSettings());
  useEffect(() => {
    const sync = () => setDenSettings(readDenSettings());
    window.addEventListener(denSettingsChangedEvent, sync);
    return () => window.removeEventListener(denSettingsChangedEvent, sync);
  }, []);
  const activeOrgId = denSettings.activeOrgId ?? null;
  const consentScopeKey = useMemo(
    () => grantedConsentScopeKey(denAuth.user?.id ?? null, activeOrgId),
    [activeOrgId, denAuth.user?.id],
  );
  const cacheScopeKey = useMemo(
    () => `${dashboardTileCacheScopeKey(denAuth.user?.id ?? null, activeOrgId)}.deployment.${encodeURIComponent(JSON.stringify([denSettings.baseUrl, denSettings.apiBaseUrl]))}`,
    [activeOrgId, denAuth.user?.id, denSettings.baseUrl, denSettings.apiBaseUrl],
  );

  const token = denSettings.authToken?.trim() || null;
  const denClient = useMemo(
    () => (token ? createDenClient({
      baseUrl: denSettings.baseUrl,
      apiBaseUrl: denSettings.apiBaseUrl,
      token,
    }) : null),
    [denSettings.apiBaseUrl, denSettings.baseUrl, token],
  );
  const grantedReady = denAuth.isSignedIn && Boolean(denClient && activeOrgId);
  const grantedQuery = useQuery({
    queryKey: ["den", "granted-dashboards", denAuth.user?.id ?? null, activeOrgId, denSettings.baseUrl, denSettings.apiBaseUrl],
    queryFn: () => {
      if (!denClient || !activeOrgId) return Promise.resolve([]);
      return denClient.listGrantedDashboards(activeOrgId);
    },
    enabled: grantedReady,
    staleTime: 30_000,
  });

  // The dashboard belongs to the signed-in member: signed out, no tile mounts
  // and no dashboard is launched or fetched, and the page leads with the same
  // sign-in banner as Library.
  if (denAuth.status !== "checking" && !denAuth.isSignedIn) return <DashboardSignedOut onSignIn={onSignIn} />;

  // Hold the board (and every launch) until its user/org scope and managed
  // dashboard payload are final.
  if (denAuth.status === "checking" || (grantedReady && grantedQuery.isPending && !grantedQuery.isFetched)
    || (Boolean(personal.client && personal.orgId) && personal.query.isPending && !personal.query.isFetched)) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8" data-dashboard-page>
        <div className="space-y-2 pt-3" role="status" aria-label="Loading dashboard">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }
  return (
    <DashboardBoard
      key={cacheScopeKey}
      consentScopeKey={consentScopeKey}
      cacheScopeKey={cacheScopeKey}
      grantedDashboards={grantedReady ? grantedQuery.data ?? [] : []}
      grantedError={grantedReady && grantedQuery.error ? true : false}
      fallbackEndpoints={fallbackEndpoints}
      onCreateApp={onCreateApp}
      headerActionsTarget={headerActionsTarget}
    />
  );
}

function DashboardBoard({ consentScopeKey, cacheScopeKey, grantedDashboards, grantedError, fallbackEndpoints, onCreateApp, headerActionsTarget }: {
  onCreateApp: CreateDashboardApp;
  headerActionsTarget?: HTMLElement | null;
  consentScopeKey: string;
  cacheScopeKey: string;
  /** Organization-managed dashboards granted to this member, rendered read-only. */
  grantedDashboards: DenGrantedDashboard[];
  grantedError: boolean;
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const [consent, setConsent] = useState<GrantedConsentMap>(() => readGrantedConsent(consentScopeKey));
  useEffect(() => {
    setConsent(readGrantedConsent(consentScopeKey));
  }, [consentScopeKey]);
  const updateConsent = (id: string, patch: { launchApproved?: true; autoLaunch?: boolean }) => {
    setConsent((current) => {
      const next: GrantedConsentMap = { ...current, [id]: { ...current[id], ...patch } };
      writeGrantedConsent(consentScopeKey, next);
      return next;
    });
  };

  return (
    <div
      className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8"
      data-dashboard-page
      data-dashboard-cache-scope={cacheScopeKey}
      data-dashboard-consent-scope={consentScopeKey}
    >
      <DashboardApps key={cacheScopeKey} onCreateApp={onCreateApp} fallbackEndpoints={fallbackEndpoints} headerActionsTarget={headerActionsTarget} />
      {grantedError ? (
        <p className="mb-4 text-xs text-muted-foreground" role="status">
          Your organization&apos;s dashboards could not be loaded right now.
        </p>
      ) : null}
      {grantedDashboards.map((dashboard) => (
        <section key={dashboard.id} className="mb-6" data-granted-dashboard={dashboard.id}>
          <header className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-medium">{dashboard.name}</h2>
            <span className="text-xs text-muted-foreground">From your company</span>
          </header>
          {dashboard.elements.length === 0 ? (
            <p className="text-xs text-muted-foreground">This dashboard has no artifacts yet.</p>
          ) : (
            <DashboardMasonry>
              {dashboard.elements.map((element) => {
                const id = grantedEntryId(dashboard.id, element);
                return (
                  <McpAppTile
                    key={id}
                    entry={grantedDashboardEntry(dashboard, element, consent[id])}
                    cacheScopeKey={cacheScopeKey}
                    onApprovedLaunch={() => updateConsent(id, { launchApproved: true })}
                    onAutoLaunchEnabled={() => updateConsent(id, { autoLaunch: true })}
                    onAutoLaunchDisabled={() => updateConsent(id, { autoLaunch: false })}
                    fallbackEndpoints={fallbackEndpoints}
                  />
                );
              })}
            </DashboardMasonry>
          )}
        </section>
      ))}

    </div>
  );
}

function DashboardSignedOut({ onSignIn }: { onSignIn?: () => void }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-6 py-8 sm:px-8" data-dashboard-page data-dashboard-signed-out>
      <CloudSignInBanner
        testId="dashboard-sign-in-banner"
        media={<CloudSignInBannerIcon><Blocks /></CloudSignInBannerIcon>}
        message={t("dashboard.sign_in_banner")}
        onSignIn={onSignIn}
      />
      <section className="flex min-h-96 flex-col items-center justify-center text-center" data-dashboard-empty>
        <div aria-hidden="true" className="mb-10 grid w-full max-w-xl grid-cols-[2fr_3fr_2fr] gap-4">{[0, 1, 2].map((index) => <div key={index} className="h-32 rounded-xl border border-dashed bg-muted/30 p-5">
          <div className="h-2.5 w-3/5 rounded-full bg-muted" />
          <div className="mt-3 h-6 w-10 rounded-md bg-muted" />
        </div>)}</div>
        <h2 className="text-xl font-semibold">Pin the artifacts you check every day</h2>
      </section>
    </div>
  );
}
