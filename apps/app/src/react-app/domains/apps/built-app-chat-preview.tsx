import { useEffect, useRef } from "react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { PanelRightOpen } from "lucide-react";
import { useMessageList } from "@/components/chat/message-list-provider";
import { Button } from "@/components/ui/button";
import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import {
  builtAppSummary,
  isAppBuilderPart,
  latestBuiltAppParts,
} from "./built-mcp-app-model";

export function BuiltAppChatPreview({ part }: { part: DynamicToolUIPart }) {
  const { sessionId, mcpAppOrigin } = useMessageList();
  const app = builtAppSummary(part);
  if (!app) return null;
  return (
    <div
      className="mt-2 flex items-center gap-2 text-sm"
      data-built-app-result={app.appId}
    >
      <span className="min-w-0 flex-1 truncate">{app.title}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={!mcpAppOrigin}
        onClick={() => {
          if (!mcpAppOrigin) return;
          usePanelTabStore
            .getState()
            .openTab(sessionId, {
              type: "mcp-app",
              id: `mcp-app:${app.appId}`,
              appId: app.appId,
              label: app.title,
              part,
              origin: mcpAppOrigin,
            });
          useUiStateStore.getState().setSidePanelState(sessionId, "panel");
        }}
      >
        <PanelRightOpen className="size-4" />
        Open preview
      </Button>
    </div>
  );
}

/** History is a baseline; only a new successful builder result opens the pane. */
export function BuiltAppPreviewSync({
  messages,
  active,
}: {
  messages: UIMessage[];
  active: boolean;
}) {
  const { sessionId, mcpAppOrigin, readOnly } = useMessageList();
  const seen = useRef<Set<string> | null>(null);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    for (const message of messages)
      for (const part of message.parts) {
        if (
          active &&
          part.type === "dynamic-tool" &&
          isAppBuilderPart(part) &&
          (part.state === "input-streaming" || part.state === "input-available")
        )
          pending.current.add(part.toolCallId);
      }
    const parts = latestBuiltAppParts(messages);
    const previous = seen.current;
    const current = new Set(
      parts.map(
        (part) => `${part.toolCallId}:${builtAppSummary(part)?.revisionId}`,
      ),
    );
    seen.current = new Set([...(previous ?? []), ...current]);
    if (!mcpAppOrigin) return;
    for (const part of parts) {
      const app = builtAppSummary(part);
      if (!app) continue;
      const id = `mcp-app:${app.appId}`;
      const tab = usePanelTabStore
        .getState()
        .sessions[sessionId]?.tabs.find((tab) => tab.id === id);
      const fresh =
        (active || pending.current.has(part.toolCallId)) &&
        previous !== null &&
        !previous.has(`${part.toolCallId}:${app.revisionId}`);
      pending.current.delete(part.toolCallId);
      if (tab || (fresh && !readOnly)) {
        // Updating the same tab keeps the panel in place; closing it stays respected.
        const activeTabId =
          usePanelTabStore.getState().sessions[sessionId]?.activeTabId ?? null;
        usePanelTabStore
          .getState()
          .openTab(sessionId, {
            type: "mcp-app",
            id,
            appId: app.appId,
            label: app.title,
            part,
            origin: mcpAppOrigin,
          });
        if (!fresh)
          usePanelTabStore.getState().selectTab(sessionId, activeTabId);
        if (fresh && !readOnly)
          useUiStateStore.getState().setSidePanelState(sessionId, "panel");
      }
    }
  }, [messages, mcpAppOrigin, readOnly, sessionId, active]);
  return null;
}
