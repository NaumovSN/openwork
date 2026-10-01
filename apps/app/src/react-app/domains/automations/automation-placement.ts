import type { AutomationExecutionTarget, AutomationExecutionTargetList } from "@openwork/types/automations"

/**
 * Where this member's Automations can run, from `GET /v1/automation-runners`.
 *
 * Desktops: any of the member's registered desktops may run a Desktop
 * Automation. The desktop build registers itself on sign-in, so it always
 * counts. Cloud: only when Den says Cloud can run agent Automations now.
 * A Den too old to answer (null) offers no choice, so callers keep their
 * fixed placement.
 */
export function automationPlacementChoices(input: {
  targets: AutomationExecutionTargetList | null | undefined
  desktopRuntime: boolean
}): AutomationExecutionTarget[] {
  if (!input.targets) return []
  const choices: AutomationExecutionTarget[] = []
  if (input.desktopRuntime || input.targets.items.some((item) => item.kind === "desktop")) choices.push("desktop")
  if (input.targets.items.some((item) => item.kind === "cloud" && item.available)) choices.push("cloud")
  return choices
}

/** The preferred placement unless only the other one exists. */
export function resolveAutomationPlacement(
  preferred: AutomationExecutionTarget,
  choices: readonly AutomationExecutionTarget[],
): AutomationExecutionTarget {
  return choices.length === 0 || choices.includes(preferred) ? preferred : choices[0]
}

/** Whether a Desktop Automation can also be run once in the cloud. */
export function automationCloudRunAvailable(targets: AutomationExecutionTargetList | null | undefined) {
  return targets?.items.some((item) => item.kind === "cloud" && item.available) === true
}
