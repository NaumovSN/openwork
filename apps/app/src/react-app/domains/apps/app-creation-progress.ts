import type { DynamicToolUIPart, UIMessage } from "ai";
import { prepareMcpAppOutputSchema } from "@openwork/types/mcp-app";
import {
  appBuilderResultFailed,
  builtAppSummary,
  isAppBuilderPart,
} from "./built-mcp-app-model";

export type AppCreationRun = {
  id: string;
  preparation?: DynamicToolUIPart;
  builds: DynamicToolUIPart[];
};
export type AppCreationStage = "needs" | "writing" | "checking" | "ready";

export function isAppPreparationPart(part: DynamicToolUIPart): boolean {
  return /(?:^|_)prepare_app$/.test(part.toolName);
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

export function appPreparation(part: DynamicToolUIPart | undefined) {
  if (
    !part ||
    part.state !== "output-available" ||
    appBuilderResultFailed(part)
  )
    return null;
  const result = field(part.callProviderMetadata?.openwork, "mcpResult");
  const structured = prepareMcpAppOutputSchema.safeParse(
    field(result, "structuredContent"),
  );
  if (structured.success) return structured.data;
  // Both engines also retain the MCP text projection. Older engines can omit metadata.
  let output: unknown = part.output;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return null;
    }
  }
  const parsed = prepareMcpAppOutputSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

/** Correlate by the server-issued preparation id, keeping separate Apps and retries separate. */
export function appCreationRuns(messages: UIMessage[]): AppCreationRun[] {
  const runs: AppCreationRun[] = [];
  const byPreparation = new Map<string, AppCreationRun>();
  const parts = new Map<string, DynamicToolUIPart>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "dynamic-tool") parts.set(part.toolCallId, part);
    }
  }
  for (const part of parts.values()) {
    if (isAppPreparationPart(part)) {
      const run: AppCreationRun = {
        id: part.toolCallId,
        preparation: part,
        builds: [],
      };
      runs.push(run);
      const preparation = appPreparation(part);
      if (preparation) byPreparation.set(preparation.preparationId, run);
    } else if (isAppBuilderPart(part)) {
      const id = field(part.input, "preparationId");
      let run = typeof id === "string" ? byPreparation.get(id) : undefined;
      // While arguments stream, the correlation id may not have arrived yet.
      if (
        (!id || (typeof id === "string" && id.length < 36)) &&
        part.state === "input-streaming" &&
        /(?:^|_)create_app$/.test(part.toolName)
      ) {
        const latest = runs.at(-1);
        if (
          latest?.preparation &&
          appPreparation(latest.preparation) &&
          latest.builds.length === 0
        )
          run = latest;
      }
      if (run) run.builds.push(part);
      else runs.push({ id: part.toolCallId, builds: [part] });
    }
  }
  return runs;
}

export function appCreationProgress(run: AppCreationRun, active: boolean) {
  const preparation = appPreparation(run.preparation);
  const build = run.builds.at(-1);
  const app = build ? builtAppSummary(build) : null;
  const failed = Boolean(
    (build && appBuilderResultFailed(build)) ||
      (!build && run.preparation && appBuilderResultFailed(run.preparation)),
  );
  const checking = build?.state === "input-available";
  const prepared = Boolean(preparation);
  const stage: AppCreationStage = app
    ? "ready"
    : checking || (build && failed)
      ? "checking"
      : prepared || build
        ? "writing"
        : "needs";
  const title =
    app?.title ??
    field(build?.input, "title") ??
    preparation?.title ??
    field(run.preparation?.input, "title");
  const detail = field(run.preparation?.input, "description");
  // Completion without a verified launch is not success (e.g. catalog capacity).
  const unavailable = Boolean(
    !failed &&
      ((build?.state === "output-available" && !app) ||
        (!build && run.preparation?.state === "output-available" && !prepared)),
  );
  const running = active && !failed && !unavailable && !app;
  return {
    stage,
    title: typeof title === "string" ? title : "App",
    prepared,
    detail: typeof detail === "string" ? detail.slice(0, 140) : null,
    preparation,
    build,
    app,
    failed,
    unavailable,
    running,
  };
}
