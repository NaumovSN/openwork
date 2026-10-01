import { useCallback } from "react";
import { useNavigate } from "react-router";

import type { AppNotification } from "@/react-app/kernel/notification-store";
import { requestOpenModelPicker } from "@/react-app/shell/new-providers-listener";
import { useReloadCoordinator } from "@/react-app/shell/reload-coordinator";

/** Keep legacy background notice actions identical in the popover and page. */
export function useActivityActions() {
  const navigate = useNavigate();
  const reloadCoordinator = useReloadCoordinator();

  return useCallback((notification: AppNotification) => {
    const action = notification.action;
    if (!action) return;
    if (action.type === "open-model-picker") {
      requestOpenModelPicker(action.providerIds);
    } else if (action.type === "reload-engine") {
      void reloadCoordinator.reloadWorkspaceEngine();
    } else if (action.type === "open-extensions-marketplace" || action.type === "install-marketplace-plugin") {
      navigate("/extensions");
    }
  }, [navigate, reloadCoordinator]);
}
