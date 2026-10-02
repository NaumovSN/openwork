import { fileURLToPath } from "node:url";
import { createBrowserPanel as createBrowserHost } from "@openwork/browser-tabs/electron";
import { runDetachedTask } from "./process-resilience.mjs";
import { openExternalUrl } from "./open-external.mjs";
import { BrowserTaskError, createBrowserTaskHost } from "./browser-task.mjs";
import { createWebMcpBroker } from "./webmcp-host.mjs";
import { createWebMcpFramePolicy } from "./webmcp-policy.mjs";

// Desktop supplies its authority and native services; the shared host owns views.
export function createBrowserPanel({ getWindow, remoteDebugPort, onDeepLink, checkPolicy, showNativeContextMenu, closeNativeContextMenu }) {
  return createBrowserHost({
    getWindow, remoteDebugPort, checkPolicy, showNativeContextMenu, closeNativeContextMenu,
    createBrowserTaskHost, createWebMcpBroker, createWebMcpFramePolicy, BrowserTaskError,
    partition: "persist:openwork-browser",
    preloadPath: fileURLToPath(import.meta.resolve("@openwork/browser-tabs/preload")),
    async openExternal(url) {
      const result = await openExternalUrl(url);
      if (!result.ok) throw new Error(result.error);
    },
    runDetachedTask,
    handleDeepLink(url) {
      if (!url.startsWith("openwork://") && !url.startsWith("openwork-dev://")) return false;
      if (typeof onDeepLink === "function") onDeepLink([url]);
      return true;
    },
  });
}
