"use client";

import type { WorkbotHost } from "@openwork-ee/workbot-ui";
import { useMemo } from "react";
import { brandIconCandidates } from "../_lib/brand-icon";
import { denApiCredentials, denBrowserEndpoint } from "../_lib/den-api-origin";
import { AUTH_TOKEN_STORAGE_KEY, getErrorMessage, requestJson } from "../_lib/den-flow";
import { getRequestOrgScope, ORG_SCOPE_HEADER } from "../_lib/org-scope";
import { getRuntimeConfig } from "../_lib/runtime-config";
import { useDenFlow } from "../_providers/den-flow-provider";
import { brandHintFor } from "../dashboard/_components/item-logo";
import { useMcpConnections } from "../dashboard/_components/mcp-connections-data";

/** The apps the member has connected (their own sign-in, or one the organization set up for everyone). */
function useConnectedApps() {
  const connections = useMcpConnections("usable");
  return useMemo(
    () =>
      (connections.data ?? [])
        .filter((connection) => connection.connected && (connection.connectedForMe || connection.credentialMode !== "per_member"))
        .map((connection) => ({ id: connection.id, name: connection.name })),
    [connections.data],
  );
}

/** Where a Den API path is served, signed in as the member in this organization. */
async function prepare(path: string) {
  await getRuntimeConfig();
  const url = denBrowserEndpoint(path);
  const headers = new Headers();
  const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const orgScope = getRequestOrgScope();
  if (orgScope) headers.set(ORG_SCOPE_HEADER, orgScope);
  return { url, headers, credentials: denApiCredentials(url, path) };
}

/** Den as Workbot's host: its sign-in, the member, their connected apps and Den's brand logos. */
export function useDenWorkbotHost(): WorkbotHost {
  const { user } = useDenFlow();
  return useMemo(
    () => ({
      requestJson,
      prepare,
      errorMessage: getErrorMessage,
      user: user ? { name: user.name ?? null } : null,
      useConnectedApps,
      appIcons: (name: string) => brandIconCandidates(brandHintFor(name)),
      homeHref: "/dashboard",
    }),
    [user],
  );
}
