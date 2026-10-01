import type { Seed } from "@openwork/env";
import { modelPickerEffortWeb } from "./chat.ts";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** The real renderer and native v2 engine, with a read-only network witness. */
export async function providerCatalogLoading(seed: Seed) {
  const world = await modelPickerEffortWeb(seed);
  const debuggerUrl = world.app.client.webSocketDebuggerUrl;
  if (!debuggerUrl) throw new Error("The picker needs a page debugger URL for its request witness");
  const socket = new WebSocket(debuggerUrl);
  const requests = new Map<string, { path: string; finished: boolean }>();
  let lastChange = Date.now();
  let failure: string | null = null;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Catalog request witness did not attach")), 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Network.enable" })));
    socket.addEventListener("error", () => {
      failure = "Catalog request witness disconnected";
      clearTimeout(timer);
      reject(new Error(failure));
    });
    socket.addEventListener("message", (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (!record(message)) return;
      if (message.id === 1) {
        clearTimeout(timer);
        if (message.error) reject(new Error("Catalog request witness could not observe the renderer"));
        else resolve();
      }
      const params = message.params;
      if (!record(params) || typeof params.requestId !== "string") return;
      if (message.method === "Network.requestWillBeSent" && record(params.request)
        && params.request.method === "GET" && typeof params.request.url === "string") {
        const path = new URL(params.request.url).pathname;
        if (!/\/opencode2\/api\/(model(?:\/default)?|provider)$/.test(path)) return;
        requests.set(params.requestId, { path, finished: false });
        lastChange = Date.now();
      }
      const request = requests.get(params.requestId);
      if (request && ["Network.loadingFinished", "Network.loadingFailed"].includes(String(message.method))) {
        request.finished = true;
        lastChange = Date.now();
      }
    });
  }).catch((error: unknown) => { socket.close(); throw error; });
  return {
    ...world,
    catalogReads: () => {
      if (failure || socket.readyState !== WebSocket.OPEN) throw new Error(failure ?? "Catalog witness closed");
      return { count: requests.size, pending: [...requests.values()].filter((request) => !request.finished).length,
        quietMs: Date.now() - lastChange, paths: [...requests.values()].map((request) => request.path) };
    },
    async [Symbol.asyncDispose]() { socket.close(); },
  };
}
