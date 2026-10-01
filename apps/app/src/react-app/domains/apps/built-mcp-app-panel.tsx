import { McpAppFrame } from "@/components/chat/mcp-app-frame";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { McpAppPanelTab } from "../session/panel/panel-tab-store";

export function BuiltMcpAppPanel({
  tab,
  onClose,
}: {
  tab: McpAppPanelTab;
  onClose: () => void;
}) {
  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto"
      aria-label={`${tab.label} preview`}
      data-built-app-preview={tab.appId}
    >
      <header className="flex h-10 items-center justify-between border-b px-3">
        <span className="truncate text-sm font-medium">{tab.label}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close panel"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>
      <div className="p-3">
        <McpAppFrame part={tab.part} origin={tab.origin} />
      </div>
    </section>
  );
}
