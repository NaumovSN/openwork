/** Controlled client benchmark; run with Bun and a clean upstream checkout.
 * bun scripts/provider-loading-benchmark.ts /absolute/path/to/upstream-dev
 * This measures client request scheduling, not production or app cold start.
 */
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createClient } from "../src/app/lib/opencode";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import * as queries from "../src/react-app/infra/provider-list-query";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";

const baselineRoot = process.argv[2];
if (!baselineRoot) throw new Error("Supply a clean upstream checkout for the baseline");
const load = (path: string) => import(pathToFileURL(resolve(baselineRoot, "apps/app/src", path)).href);
const baseline = {
  adapter: await load("app/lib/opencode-v2-adapter.ts"),
  store: await load("react-app/domains/connections/provider-auth/store.ts"),
  queries: await load("react-app/infra/provider-list-query.ts"),
};
const head = { adapter: { createClientV2 }, store: { createProviderAuthStore }, queries };
const samples = Number(process.env.OPENWORK_PROVIDER_BENCH_SAMPLES ?? 9);
const delays = (process.env.OPENWORK_PROVIDER_BENCH_DELAYS ?? "0,60,180").split(",").map(Number);
if (!Number.isInteger(samples) || samples < 1 || samples > 100 || delays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
  throw new Error("Use 1–100 samples and nonnegative delays");
}
let delayMs = 0;
let modelCount = 25;
let requests = 0;
let bytes = 0;
let catalog: { all: ProviderListItem[]; connected: string[]; default: Record<string, string> };
let models: { id: string; providerID: string; name: string }[];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  requests += 1;
  const path = new URL(request.url).pathname;
  const delay = path.endsWith("/config") || path.endsWith("/api/provider") ? delayMs * 2 / 3
    : path.endsWith("/api/model/default") ? delayMs / 4 : delayMs;
  if (delay > 0) await Bun.sleep(delay);
  const payload = path.endsWith("/config") ? { disabled_providers: [] }
    : path.endsWith("/api/model") ? { data: models }
    : path.endsWith("/api/model/default") ? { data: catalog.default }
    : path.endsWith("/api/provider") ? { data: catalog.all.map(({ id, name }) => ({ id, name })) }
    : path.endsWith("/provider") ? catalog : null;
  if (!payload) return new Response("unexpected request", { status: 404 });
  const body = JSON.stringify(payload);
  bytes += new TextEncoder().encode(body).byteLength;
  return new Response(body, { headers: { "content-type": "application/json" } });
} });
const baseUrl = `http://127.0.0.1:${server.port}`;
const workspace: WorkspaceDisplay = { id: "benchmark", name: "Benchmark", path: "/synthetic-workspace", preset: "default", workspaceType: "local" };

function storeOptions(client: ReturnType<typeof createClient>) {
  return {
    client: () => client, providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    checkDesktopAppRestriction: () => false, selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => baseUrl, selectedWorkspaceRoot: () => workspace.path, runtimeWorkspaceId: () => workspace.id,
    openworkServer: { getSnapshot: () => ({ openworkServerStatus: "disconnected", openworkServerClient: null, openworkServerCapabilities: null }) },
    setProviders: () => undefined, setProviderDefaults: () => undefined, setProviderConnectedIds: () => undefined,
    setDisabledProviders: () => undefined, markOpencodeConfigReloadRequired: () => undefined,
  } satisfies Parameters<typeof createProviderAuthStore>[0];
}

async function measure(version: typeof head, operation: "discovery" | "refresh" | "v2") {
  const client = createClient(baseUrl, workspace.path);
  const queryClient = operation === "discovery" ? getReactQueryClient() : new QueryClient();
  version.queries.clearProviderListQueries(queryClient);
  const input = { client, baseUrl, directory: workspace.path };
  const store = operation === "discovery" ? version.store.createProviderAuthStore(storeOptions(client)) : null;
  let unsubscribe: (() => void) | undefined;
  if (operation === "refresh") {
    await version.queries.ensureProviderListQuery(queryClient, input);
    unsubscribe = new QueryObserver(queryClient, {
      queryKey: version.queries.providerListQueryKey(input),
      queryFn: () => version.queries.fetchProviderList(input), staleTime: queries.PROVIDER_LIST_CACHE_MS,
    }).subscribe(() => undefined);
  }
  requests = 0;
  bytes = 0;
  const started = performance.now();
  try {
    if (operation === "discovery") {
      const result = await store?.refreshProviders();
      if (result?.all.flatMap((provider) => Object.keys(provider.models)).length !== modelCount) throw new Error("Discovery returned an incomplete catalog");
    } else if (operation === "refresh") {
      await version.queries.refreshProviderListQueries(queryClient);
    } else {
      const result = await version.adapter.createClientV2(baseUrl + "/opencode2", workspace.path, {}).provider.list();
      if (result.data?.all.flatMap((provider) => Object.keys(provider.models)).length !== modelCount) throw new Error("V2 returned an incomplete catalog");
    }
    return { ms: performance.now() - started, requests, bytes };
  } finally {
    unsubscribe?.();
    store?.dispose();
    version.queries.clearProviderListQueries(queryClient);
    queryClient.clear();
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const results = [];
try {
  for (modelCount of [25, 1000]) {
    models = Array.from({ length: modelCount }, (_, id) => ({ id: `model-${id}`, providerID: `provider-${id % 5}`, name: `Model ${id}` }));
    catalog = { all: Array.from({ length: 5 }, (_, id) => ({ id: `provider-${id}`, name: `Provider ${id}`, source: "config", env: [],
      models: Object.fromEntries(models.filter((model) => model.providerID === `provider-${id}`).map((model) => [model.id, { ...model, api: { id: model.id, url: baseUrl, npm: "@ai-sdk/openai-compatible" }, cost: { input: 0, output: 0 }, limit: { context: 128000, output: 8192 }, capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" }])) })),
      connected: Array.from({ length: 5 }, (_, id) => `provider-${id}`), default: { "provider-0": "model-0" } };
    for (delayMs of delays) {
      for (const operation of ["discovery", "refresh", "v2"] as const) {
        const before = [], after = [];
        for (let iteration = -1; iteration < samples; iteration += 1) {
          for (const name of iteration % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
            const value = await measure(name === "before" ? baseline : head, operation);
            if (iteration >= 0) (name === "before" ? before : after).push(value);
          }
        }
        const beforeMs = median(before.map((sample) => sample.ms)), afterMs = median(after.map((sample) => sample.ms));
        const summarize = (values: typeof before) => ({ medianMs: Number(median(values.map((sample) => sample.ms)).toFixed(2)),
          minMs: Number(Math.min(...values.map((sample) => sample.ms)).toFixed(2)), maxMs: Number(Math.max(...values.map((sample) => sample.ms)).toFixed(2)),
          requests: median(values.map((sample) => sample.requests)), bytes: median(values.map((sample) => sample.bytes)) });
        results.push({ models: modelCount, delayMs, operation, before: summarize(before), after: summarize(after), reductionPercent: Number(((1 - afterMs / beforeMs) * 100).toFixed(1)) });
      }
    }
  }
  console.log(JSON.stringify({ methodology: "Loopback HTTP; actual client/store/query code; one warmup and nine alternating samples per side; injected catalog latency; no production or cold-start claim", samples, results }, null, 2));
} finally { server.stop(true); }
