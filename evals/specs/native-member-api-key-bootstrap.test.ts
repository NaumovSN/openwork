import { GlobalRegistrator } from "../../apps/app/node_modules/@happy-dom/global-registrator/lib/index.js";
import { afterAll, expect } from "vitest";
import { test } from "@openwork/testkit";

GlobalRegistrator.register({ url: "https://desktop.example.test" });
afterAll(() => GlobalRegistrator.unregister());

test("native bootstrap persists an explicit API without replacing it from runtime metadata", async ({ evidence }) => {
  let persisted = { baseUrl: "https://web.example.test", apiBaseUrl: "https://web.example.test/api/den", requireSignin: false };
  const reads: string[] = [];
  let writes = 0;
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", { configurable: true, value: {
    meta: { desktopBootstrap: persisted },
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      if (command === "getDesktopBootstrapConfig") return { ...persisted, fromFile: true };
      if (command === "setDesktopBootstrapConfig") {
        const value = args[0];
        if (!value || typeof value !== "object" || !("baseUrl" in value) || typeof value.baseUrl !== "string"
          || !("apiBaseUrl" in value) || typeof value.apiBaseUrl !== "string") throw new Error("Invalid fixture bootstrap");
        persisted = { baseUrl: value.baseUrl, apiBaseUrl: value.apiBaseUrl, requireSignin: false };
        writes++;
        return { ...persisted, fromFile: true };
      }
      if (command === "__fetch") {
        if (typeof args[0] !== "string") throw new Error("Invalid fixture request");
        reads.push(args[0]);
        return { status: 200, statusText: "OK", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ denApiUrl: "https://unrelated.example.test" }) };
      }
      throw new Error("Unexpected fixture command");
    },
  } });
  const { initializeDenBootstrapConfig, setDenBootstrapConfig, readDenBootstrapConfig } = await import("../../apps/app/src/app/lib/den");
  await initializeDenBootstrapConfig();
  reads.length = 0;
  const intendedApi = "https://web.example.test/api/den";
  const result = await setDenBootstrapConfig({ baseUrl: "https://web.example.test", apiBaseUrl: intendedApi, requireSignin: false });
  expect(writes).toBe(1);
  expect(persisted.apiBaseUrl).toBe(intendedApi);
  expect(result.apiBaseUrl).toBe(intendedApi);
  expect(readDenBootstrapConfig().apiBaseUrl).toBe(intendedApi);
  expect(reads).toEqual([]);
  evidence.recordAssertionEvidence("Explicit native routing remains authoritative", "Actual bootstrap persistence and renderer readback preserve the supplied API; unrelated runtime metadata is never queried to replace that explicit endpoint.", true);
});
