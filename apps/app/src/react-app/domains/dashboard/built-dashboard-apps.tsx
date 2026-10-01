import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import fuzzysort from "fuzzysort";
import { Blocks, Check, Minus, RefreshCw } from "lucide-react";
import { DenApiError } from "@/app/lib/den";
import type { BuiltMcpAppCatalogEntry } from "@/app/lib/built-mcp-app-catalog";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppsClient } from "../apps/use-apps";
import { BuiltAppShareButton } from "../apps/built-app-share-button";
import { McpAppTile, type DashboardLaunchEndpoint } from "./mcp-app-tile";
import { DashboardMasonry } from "./dashboard-masonry";
import { dashboardTileCacheScopeKey } from "./dashboard-tile-cache";
import { mcpAppIdSchema } from "@openwork/types/mcp-app";

export function builtDashboardScope(
  scope: ReturnType<typeof useAppsClient>["scope"],
) {
  return `openwork:personal-mcp-apps:v1:${JSON.stringify(scope)}`;
}

export function readBuiltDashboardApps(scope: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(scope) ?? "[]",
    );
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (id): id is string => mcpAppIdSchema.safeParse(id).success,
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export function useBuiltDashboardApps() {
  const context = useAppsClient();
  const key = builtDashboardScope(context.scope);
  const [placement, setPlacement] = useState<{ key: string; ids: string[] }>(
    () => ({ key, ids: readBuiltDashboardApps(key) }),
  );
  const ids =
    placement.key === key ? placement.ids : readBuiltDashboardApps(key);
  useEffect(() => {
    setPlacement({ key, ids: readBuiltDashboardApps(key) });
  }, [key]);
  const query = useQuery({
    queryKey: ["built-dashboard-apps", ...context.scope],
    enabled: Boolean(
      context.client && context.orgId && context.identityVerified,
    ),
    queryFn: async () => {
      if (!context.client || !context.orgId)
        throw new Error("Sign in to browse apps.");
      try {
        return await context.client.listBuiltMcpApps(context.orgId);
      } catch (error) {
        // Older deployments did not have a member-accessible App catalog.
        if (
          error instanceof DenApiError &&
          (error.status === 404 || error.status === 403)
        )
          return null;
        throw error;
      }
    },
    staleTime: 15_000,
  });
  const apps = context.identityVerified ? (query.data ?? []) : [];
  return {
    ...context,
    query,
    apps,
    ids,
    ready: context.identityVerified && query.isSuccess && query.data !== null,
    cacheScopeKey: `${dashboardTileCacheScopeKey(context.scope[1] ?? null, context.orgId ?? null)}.built.${JSON.stringify(context.scope)}`,
    setAdded: (appId: string, added: boolean) => {
      if (
        !context.identityVerified ||
        !apps.some((app) => app.connectionId === appId)
      )
        return;
      const next = added
        ? [...new Set([...ids, appId])]
        : ids.filter((id) => id !== appId);
      setPlacement({ key, ids: next });
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* In-memory placement remains usable. */
      }
    },
  };
}

export type BuiltDashboardApps = ReturnType<typeof useBuiltDashboardApps>;

export function BuiltAppPicker({
  built,
  onAdded,
}: {
  built: BuiltDashboardApps;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const matching = useMemo(
    () =>
      search.trim()
        ? fuzzysort
            .go(search, built.apps, {
              keys: ["title", "description", "pluginName"],
            })
            .map((result) => result.obj)
        : built.apps,
    [built.apps, search],
  );
  return (
    <Command
      items={matching}
      filter={null}
      value={search}
      onValueChange={setSearch}
    >
      <CommandInput
        aria-label="Search apps"
        placeholder="Search apps"
      />
      <CommandEmpty>No apps match your search.</CommandEmpty>
      <CommandList>
        {(app: BuiltMcpAppCatalogEntry) => (
          <CommandItem
            key={app.connectionId}
            value={app}
            aria-label={`Add ${app.title}`}
            disabled={built.ids.includes(app.connectionId)}
            onClick={() => {
              built.setAdded(app.connectionId, true);
              onAdded();
            }}
          >
            <Blocks className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{app.title}</span>
            <span className="text-xs text-muted-foreground">
              {built.ids.includes(app.connectionId) ? (
                <Check className="size-4" aria-label="Added" />
              ) : (
                "Add"
              )}
            </span>
          </CommandItem>
        )}
      </CommandList>
    </Command>
  );
}

export function BuiltDashboardTiles({
  built,
  fallbackEndpoints,
}: {
  built: BuiltDashboardApps;
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const personal = built.apps.filter((app) =>
    built.ids.includes(app.connectionId),
  );
  if (built.query.isPending && built.identityVerified)
    return <Skeleton className="mb-4 h-12 w-full" />;
  if (built.query.isError)
    return (
      <div className="mb-4 flex items-center gap-2">
        <p role="alert" className="text-sm">
          Shared apps could not be loaded.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void built.query.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  if (!personal.length) return null;
  return (
    <section className="mb-8" aria-label="Apps added by you">
      <DashboardMasonry>
        {personal.map((app) => (
          <McpAppTile
            key={app.connectionId}
            cacheScopeKey={built.cacheScopeKey}
            fallbackEndpoints={fallbackEndpoints}
            entry={{
              ...app,
              kind: "mcp",
              id: `personal:${app.connectionId}`,
              launchArguments: { input: {} },
              autoLaunch: true,
            }}
            renderActions={({ onRefresh, refreshing }) => (
              <div className="flex gap-1 rounded-md bg-background/90">
                {onRefresh ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={refreshing}
                    aria-label={`Refresh ${app.title}`}
                    onClick={onRefresh}
                  >
                    <RefreshCw
                      className={`size-4 ${refreshing ? "animate-spin" : ""}`}
                    />
                  </Button>
                ) : null}
                <BuiltAppShareButton
                  pluginId={app.pluginId}
                  title={app.title}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${app.title} from dashboard`}
                  onClick={() => built.setAdded(app.connectionId, false)}
                >
                  <Minus className="size-4" />
                </Button>
              </div>
            )}
          />
        ))}
      </DashboardMasonry>
    </section>
  );
}
