import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { CloudLoginNotice } from "@/components/cloud-login-notice";
import { SystemEventsTab } from "@/domains/logs/components/system-events-tab";
import {
  useActiveAssistantIsCloudHosted,
  useCloudGate,
} from "@/hooks/use-cloud-gate";
import { routes } from "@/utils/routes";
import { Notice } from "@mycadet/design-library/components/notice";

import { useTranslation } from "@/i18n";

export function SystemEventsPage() {
  const { t } = useTranslation("logs");
  const cloudGate = useCloudGate({ cloudHostedOnly: true });
  const isCloudHosted = useActiveAssistantIsCloudHosted();
  const assistantId = useActiveAssistantId();

  if (cloudGate === "gated") {
    return <Navigate replace to={routes.logs.root} />;
  }

  if (cloudGate === "disabled") {
    return (
      <CloudLoginNotice>
        {t("systemEventsPage.platformLoginNotice")}
      </CloudLoginNotice>
    );
  }

  if (!isCloudHosted) {
    return <Notice tone="warning">{t("systemEventsPage.notAvailable")}</Notice>;
  }

  return <SystemEventsTab assistantId={assistantId} />;
}
