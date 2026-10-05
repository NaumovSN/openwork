import type { Metadata } from "next";
import "@openwork-ee/workbot-ui/styles.css";
import { DashboardQueryClientProvider } from "../dashboard/_providers/query-client-provider";
import { OrgDashboardProvider } from "../dashboard/_providers/org-dashboard-provider";

export const metadata: Metadata = { title: "Workbot" };

/** Workbot (@openwork-ee/workbot-ui) is one full-height conversation: the dashboard's data providers, none of its chrome. */
export default function WorkbotLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardQueryClientProvider>
      <OrgDashboardProvider>{children}</OrgDashboardProvider>
    </DashboardQueryClientProvider>
  );
}
