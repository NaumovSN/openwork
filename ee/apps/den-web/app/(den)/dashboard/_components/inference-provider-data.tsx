"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InferenceAccess, FreeInferenceProviderSummary } from "@openwork/types/den/inference";
import { z } from "zod";
import type { GatewayAccessGrantWrite, GatewayCredentialSetWrite, GatewayModelGroupWrite } from "@openwork/types/den/gateway";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import {
  buildMigrateFromLlmProviderBody,
  readInferenceProviderFromPayload,
  readInferenceProvidersFromPayload,
  readInferenceProviderDetails,
  readOpenWorkModelAccess,
  readFreeInferenceProvider,
  type DenInferenceProviderDetails,
  type DenInferenceProvider,
  type InferenceProviderRequestBody,
} from "./inference-provider-request";

export function useOpenWorkFreeProvider(orgId: string | null) {
  const generation = useRef(0);
  const [state, setState] = useState<{ orgId: string; provider: FreeInferenceProviderSummary } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setError(null);
    if (!orgId) { setState(null); setBusy(false); return; }
    setBusy(true);
    try {
      const { response, payload } = await requestJson("/v1/inference/free/provider", { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId } }, 15000);
      if (request !== generation.current) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) setState(null);
        throw getRequestError(payload, response, "Could not refresh organization allowance. Try again.");
      }
      const provider = readFreeInferenceProvider(payload);
      if (!provider) throw new Error("The server did not return a complete organization allowance summary.");
      setState({ orgId, provider });
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "Could not refresh organization allowance.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [orgId]);
  useEffect(() => { void reload(); return () => { generation.current += 1; }; }, [reload]);
  const updatePin = useCallback((defaultPinned: boolean) => {
    setState((current) => current?.orgId === orgId ? { ...current, provider: { ...current.provider, defaultPinned } } : current);
  }, [orgId]);
  return { provider: state?.orgId === orgId ? state.provider : null, busy, error, reload, updatePin };
}

export async function saveOpenWorkAutoPin(orgId: string, defaultPinned: boolean) {
  const { response, payload } = await requestJson("/v1/inference/free/pins", {
    method: "PATCH", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify({ defaultPinned }),
  }, 15000);
  if (!response.ok) throw getRequestError(payload, response, "Could not save the organization Auto pin.");
  const saved = z.object({ defaultPinned: z.boolean() }).safeParse(payload);
  if (!saved.success) throw new Error("The server did not confirm the Auto pin. Refresh before trying again.");
  return saved.data.defaultPinned;
}

export function useOpenWorkModelAccess(orgId: string | null) {
  const generation = useRef(0);
  const [state, setState] = useState<{ orgId: string; access: InferenceAccess } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setError(null);
    if (!orgId) { setState(null); setBusy(false); return; }
    setBusy(true);
    try {
      const { response, payload } = await requestJson("/v1/inference/access", { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId } }, 15000);
      if (request !== generation.current) return;
      if (!response.ok) throw new Error("Could not verify OpenWork Models. Refresh to try again.");
      const access = readOpenWorkModelAccess(payload);
      if (!access) throw new Error("OpenWork model access is unavailable from this server. Refresh after the server is updated.");
      setState({ orgId, access });
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "Could not verify OpenWork Models.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [orgId]);
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);
  return { access: state?.orgId === orgId ? state.access : null, busy, error, reload };
}

export function useOrgInferenceProviders(orgId: string | null) {
  const generation = useRef(0);
  const [inferenceProviders, setInferenceProviders] = useState<DenInferenceProvider[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    const request = ++generation.current;
    if (!orgId) {
      setInferenceProviders([]);
      setBusy(false);
      setError("Organization not found.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(`/v1/inference-providers?scope=manageable`, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId } }, 15000);
      if (request !== generation.current) return;
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load gateway providers (${response.status}).`));
      }
      setInferenceProviders(readInferenceProvidersFromPayload(payload));
    } catch (loadError) {
      if (request !== generation.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load gateway providers.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [orgId]);

  useEffect(() => {
    void loadProviders();
    return () => { generation.current += 1; };
  }, [loadProviders]);

  return { inferenceProviders, busy, error, reloadProviders: loadProviders };
}

/** One provider with its access grants and credential list (no secret values). */
export function useInferenceProvider(orgId: string | null, inferenceProviderId: string | null) {
  const generation = useRef(0);
  const [provider, setProvider] = useState<DenInferenceProviderDetails | null>(null);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const scope = orgId && inferenceProviderId ? `${orgId}:${inferenceProviderId}` : null;
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!orgId || !inferenceProviderId) {
      setProvider(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(
        `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}`,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId } },
        15000,
      );
      if (request !== generation.current) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) setProvider(null);
        throw new Error(getErrorMessage(payload, `Failed to load the provider (${response.status}).`));
      }
      const catalog = await requestJson(`/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/models`, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId } }, 15000);
      if (request !== generation.current) return;
      if (!catalog.response.ok) {
        if ([401, 403, 404].includes(catalog.response.status)) setProvider(null);
        throw new Error(getErrorMessage(catalog.payload, "Could not load configured catalog models."));
      }
      const next = readInferenceProviderDetails(payload, catalog.payload);
      if (!next) {
        throw new Error("The server did not return valid model groups, credential sets and access rules. Matrix editing is unavailable until the API is updated.");
      }
      setProvider(next);
      setLoadedScope(`${orgId}:${inferenceProviderId}`);
    } catch (loadError) {
      if (request !== generation.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load the provider.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [orgId, inferenceProviderId]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  return { provider: loadedScope === scope ? provider : null, busy, error, reload: load };
}

export async function saveInferenceProvider(input: {
  inferenceProviderId: string | null;
  body: Partial<InferenceProviderRequestBody>;
}): Promise<DenInferenceProvider> {
  const path = input.inferenceProviderId
    ? `/v1/inference-providers/${encodeURIComponent(input.inferenceProviderId)}`
    : `/v1/inference-providers`;
  const { response, payload } = await requestJson(
    path,
    { method: input.inferenceProviderId ? "PATCH" : "POST", body: JSON.stringify(input.body) },
    20000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to save the gateway provider (${response.status}).`);
  }
  const provider = readInferenceProviderFromPayload(payload);
  if (!provider) {
    throw new Error("The provider was saved, but no provider was returned.");
  }
  return provider;
}

type GatewayResourceWrite =
  | { resource: "model-groups"; body: GatewayModelGroupWrite }
  | { resource: "credential-sets"; body: GatewayCredentialSetWrite }
  | { resource: "access-grants"; body: GatewayAccessGrantWrite };

export async function saveGatewayResource(providerId: string, id: string | null, input: GatewayResourceWrite) {
  const path = `/v1/inference-providers/${encodeURIComponent(providerId)}/${input.resource}${id ? `/${encodeURIComponent(id)}` : ""}`;
  const { response, payload } = await requestJson(path, {
    method: id ? "PATCH" : "POST", body: JSON.stringify(input.body),
  }, 20000);
  if (!response.ok) throw getRequestError(payload, response, `Could not save ${input.resource} (${response.status}).`);
}

export async function deleteGatewayResource(providerId: string, resource: GatewayResourceWrite["resource"], id: string) {
  const { response, payload } = await requestJson(
    `/v1/inference-providers/${encodeURIComponent(providerId)}/${resource}/${encodeURIComponent(id)}`,
    { method: "DELETE" }, 20000,
  );
  if (!response.ok) throw getRequestError(payload, response, `Could not delete ${resource} (${response.status}).`);
}

export async function deleteInferenceProvider(inferenceProviderId: string) {
  const { response, payload } = await requestJson(
    `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}`,
    { method: "DELETE" },
    12000,
  );
  if (response.status !== 204 && !response.ok) {
    throw getRequestError(payload, response, `Failed to delete the gateway provider (${response.status}).`);
  }
}

/** Moves a models.dev BYOK provider to the gateway; returns the new gateway provider. */
export async function migrateLlmProviderToGateway(llmProviderId: string): Promise<DenInferenceProvider> {
  const { response, payload } = await requestJson(
    `/v1/inference-providers/migrate-from-llm-provider`,
    { method: "POST", body: JSON.stringify(buildMigrateFromLlmProviderBody(llmProviderId)) },
    20000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to move the provider to the gateway (${response.status}).`);
  }
  const provider = readInferenceProviderFromPayload(payload);
  if (!provider) {
    throw new Error("The provider was moved, but no gateway provider was returned.");
  }
  return provider;
}
