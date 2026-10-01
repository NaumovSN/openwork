import type { DynamicToolUIPart } from "ai";
import { trackToolCallDuration } from "@/lib/tool-call-duration";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { TechnicalDetailsPanel } from "./capability-call-line";

export function AppBuilderStep({
  part,
  statusUnknown,
}: {
  part: DynamicToolUIPart;
  statusUnknown: boolean;
}) {
  const running = !statusUnknown && isToolPartInFlight(part);
  const editing = /(?:^|_)update_app$/.test(part.toolName);
  const title =
    part.input && typeof part.input === "object"
      ? Reflect.get(part.input, "title")
      : null;
  const label = statusUnknown
    ? "App building paused"
    : running
      ? editing
        ? "Updating app"
        : "Creating app"
      : editing
        ? "Updated app"
        : "Created app";
  return (
    <div className="py-1" data-app-builder-step>
      <div className="flex items-center gap-2 text-sm">
        <img
          src="/openwork-mark.svg"
          alt="OpenWork"
          className="size-4 dark:invert"
        />
        <span
          className={
            running ? "ow-text-shimmer motion-reduce:animate-none" : undefined
          }
        >
          {label}
          {typeof title === "string" ? `: ${title}` : ""}
        </span>
        {!statusUnknown ? (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {trackToolCallDuration(part)}
          </span>
        ) : null}
      </div>
      <details className="mt-1 text-xs text-muted-foreground">
        <summary>Technical details</summary>
        <TechnicalDetailsPanel part={part} />
      </details>
    </div>
  );
}
