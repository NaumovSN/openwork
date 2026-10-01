import { createDenClient } from "@/app/lib/den"

export type AutomationsClient = Pick<
  ReturnType<typeof createDenClient>,
  | "activateAutomation"
  | "archiveAutomation"
  | "cancelAutomationRun"
  | "createAutomation"
  | "createCloudAutomation"
  | "deactivateAutomation"
  | "getAutomation"
  | "getAutomationRun"
  | "listAutomationRunners"
  | "listAutomationRuns"
  | "listAutomations"
  | "listOrgLlmProviders"
  | "runAutomationNow"
  | "updateAutomation"
>
