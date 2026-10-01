/** Compare actual client reads against the same running OpenWork server/engine.
 * Run from apps/app with a clean baseline checkout argument. Supply endpoint,
 * directory, token and engine through stdin; credentials are never printed.
 * No fake HTTP server, synthetic catalog, injected delay or inference is used.
 */
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createClient } from "../src/app/lib/opencode";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import * as queries from "../src/react-app/infra/provider-list-query";

const baselineRoot = process.argv[2];
if (!baselineRoot) throw new Error("Supply a clean baseline checkout");
const input: unknown = await Bun.stdin.json();
if (!input || typeof input !== "object" || !("baseUrl" in input) || typeof input.baseUrl !== "string"
  || !("directory" in input) || typeof input.directory !== "string" || !("token" in input) || typeof input.token !== "string"
  || !("engine" in input) || (input.engine !== "v1" && input.engine !== "v2")) throw new Error("Invalid native benchmark input");
const { baseUrl, directory, token, engine } = input;
const load = (path: string) => import(pathToFileURL(resolve(baselineRoot, "apps/app/src", path)).href);
const baseline = {
  adapter: await load("app/lib/opencode-v2-adapter.ts"),
  queries: await load("react-app/infra/provider-list-query.ts"),
};
const head = { adapter: { createClientV2 }, queries };
const originalFetch = globalThis.fetch;
let measuredRequests = 0;
// Observe requests while leaving responses and their timing unchanged.
globalThis.fetch = (request, init) => {
  const url = request instanceof Request ? request.url : String(request);
  if (url.startsWith(baseUrl)) measuredRequests += 1;
  return originalFetch(request, init);
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
async function measure(version: typeof head) {
  const client = engine === "v2" ? version.adapter.createClientV2(baseUrl, directory, { token })
    : createClient(baseUrl, directory, { token, mode: "openwork" });
  const queryClient = new QueryClient();
  version.queries.clearProviderListQueries(queryClient);
  const queryInput = { client, baseUrl, directory };
  await version.queries.ensureProviderListQuery(queryClient, queryInput);
  const unsubscribe = new QueryObserver(queryClient, {
    queryKey: version.queries.providerListQueryKey(queryInput),
    queryFn: () => version.queries.fetchProviderList(queryInput), staleTime: Infinity,
  }).subscribe(() => undefined);
  measuredRequests = 0;
  const started = performance.now();
  try {
    await version.queries.refreshProviderListQueries(queryClient);
    return { ms: performance.now() - started, requests: measuredRequests };
  } finally {
    unsubscribe(); version.queries.clearProviderListQueries(queryClient); queryClient.clear();
  }
}
try {
  const results = [];
  {
    const operation = "refresh";
    const before = [], after = [];
    for (let sample = -1; sample < 9; sample += 1) {
      for (const side of sample % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
        const value = await measure(side === "before" ? baseline : head);
        if (sample >= 0) (side === "before" ? before : after).push(value);
      }
    }
    const summarize = (values: typeof before) => ({ medianMs: Number(median(values.map(({ ms }) => ms)).toFixed(2)),
      minMs: Number(Math.min(...values.map(({ ms }) => ms)).toFixed(2)), maxMs: Number(Math.max(...values.map(({ ms }) => ms)).toFixed(2)),
      requests: median(values.map(({ requests }) => requests)), samplesMs: values.map(({ ms }) => Number(ms.toFixed(2))) });
    results.push({ operation, before: summarize(before), after: summarize(after) });
  }
  const paths = engine === "v1" ? ["/config/providers"] : ["/api/model", "/api/model/default", "/api/provider"];
  const payloads = [];
  for (const path of paths) {
    const response = await originalFetch(baseUrl + path, { headers: { Authorization: "Bearer " + token, "x-opencode-directory": directory } });
    if (!response.ok) throw new Error("Native payload sizing failed");
    payloads.push({ path, bytes: (await response.arrayBuffer()).byteLength });
  }
  console.log(JSON.stringify({ engine, samplesPerSide: 9, methodology: "Same real managed server and bundled engine; built-in OpenCode Zen; warmed catalog; alternating client versions; no injected latency or inference; client runs in Bun", results, payloads }));
} finally { globalThis.fetch = originalFetch; }
