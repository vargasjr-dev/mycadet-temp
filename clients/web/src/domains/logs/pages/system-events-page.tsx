import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { SystemEventsTab } from "@/domains/logs/components/system-events-tab";
import {
  useActiveAssistantIsCloudHosted,
  useActiveAssistantIsSelfHosted,
} from "@/assistant/hosting";
import { routes } from "@/utils/routes";
import { Notice } from "@mycadet/design-library/components/notice";

import { useTranslation } from "@/i18n";

export function SystemEventsPage() {
  const { t } = useTranslation("logs");
  const isSelfHosted = useActiveAssistantIsSelfHosted();
  const isCloudHosted = useActiveAssistantIsCloudHosted();
  const assistantId = useActiveAssistantId();

  if (isSelfHosted) {
    return <Navigate replace to={routes.logs.root} />;
  }

  if (!isCloudHosted) {
    return <Notice tone="warning">{t("systemEventsPage.notAvailable")}</Notice>;
  }

  return <SystemEventsTab assistantId={assistantId} />;
}
