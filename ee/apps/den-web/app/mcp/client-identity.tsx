"use client";

import type { SetupFact } from "../(den)/_components/setup-frame-parts";
import { describeMcpRedirect, type McpRedirectDescription } from "./client-identity-model";
import { McpAppFact } from "./mcp-story";
import type { McpClient } from "./use-mcp-client";

/** Where the approval is sent, from the signed authorize query. */
export function useMcpRedirect(oauthQuery: string): McpRedirectDescription | null {
  return describeMcpRedirect(oauthQuery ? new URLSearchParams(oauthQuery).get("redirect_uri") : null);
}

/** The App and Returns to rows that lead every consent panel (P9). */
export function mcpIdentityFacts(client: McpClient, redirect: McpRedirectDescription | null): { app: SetupFact; returnsTo: SetupFact } {
  return {
    app: { label: "App", value: <McpAppFact client={client} /> },
    returnsTo: { label: "Returns to", value: redirect?.host ?? "Unknown", mono: true, testId: "mcp-redirect-host" },
  };
}

/**
 * One plain line above the button when the return address needs a second
 * look: a loopback-only redirect (anything on this computer could use the
 * access) or an app that shared no name (name the host to check).
 */
export function McpReturnLine({ client, redirect, short = false }: { client: McpClient; redirect: McpRedirectDescription | null; short?: boolean }) {
  if (!client.loaded) return null;
  if (redirect?.loopbackOnly) {
    return (
      <p className="m-0 text-[13px] leading-5 text-[var(--setup-ink-soft)]" role="status" data-testid="mcp-loopback-warning">
        {short
          ? "This app returns to your own computer. Only continue if you started this sign-in here just now."
          : "This app returns to your own computer. Anything running on it could use this access, so only continue if you started this sign-in here just now."}
      </p>
    );
  }
  if (!client.name && redirect) {
    return (
      <p className="m-0 text-[13px] leading-5 text-[var(--setup-ink-soft)]" role="status" data-testid="mcp-unnamed-app-line">
        This app did not share its name. Only continue if you know {redirect.host} and started this sign-in.
      </p>
    );
  }
  return null;
}
