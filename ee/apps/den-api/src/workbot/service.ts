import { createWorkbot, type WorkbotActor as WorkbotMemberInput, type WorkbotDeps } from "@openwork-ee/workbot-server"
import { cloudAutomationRuntime } from "../automations/headless-runtime.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps, headlessRunnerConfig } from "../headless-runner/client.js"
import { organizationHasCapability } from "../organization-capabilities.js"

/**
 * Den hosts Workbot (@openwork-ee/workbot-server): it signs the member in, decides whether Workbot is on for their
 * organization, and supplies the headless runner and whether Automations can run headless.
 */
export { WorkbotFilesUnavailableError, WorkbotUnavailableError } from "@openwork-ee/workbot-server"

/** The signed-in member, with Den's organization metadata (its capabilities decide whether Workbot is on). */
export type WorkbotActor = WorkbotMemberInput & { organizationMetadata: Parameters<typeof organizationHasCapability>[0] }

export function defaultWorkbotDeps(): WorkbotDeps {
  const runner = defaultHeadlessRunnerDeps()
  return {
    client: runner ? createHeadlessRunnerClient(runner) : null,
    canSchedule: async (organizationId) => (await cloudAutomationRuntime(organizationId)) === "headless",
  }
}

/** On for an organization when a platform admin enabled it and this deployment has a headless runner. */
export function workbotEnabled(metadata: Parameters<typeof organizationHasCapability>[0], env: Record<string, string | undefined> = process.env) {
  return organizationHasCapability(metadata, "workbot") && headlessRunnerConfig(env) !== null
}

/** Workbot bound to this process's runner; read per request so configuration changes apply without a restart. */
export function workbot(): ReturnType<typeof createWorkbot> {
  return createWorkbot(defaultWorkbotDeps())
}

export type { WorkbotDeps }
