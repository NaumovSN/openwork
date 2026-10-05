"use client";

import { WorkbotScreen } from "@openwork-ee/workbot-ui";
import { useDenWorkbotHost } from "./workbot-host";

export default function WorkbotPage() {
  return <WorkbotScreen host={useDenWorkbotHost()} />;
}
