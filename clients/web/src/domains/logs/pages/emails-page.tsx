import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { CloudLoginNotice } from "@/components/cloud-login-notice";
import { EmailsTab } from "@/domains/logs/components/emails-tab";
import { useCloudGate } from "@/hooks/use-cloud-gate";
import { routes } from "@/utils/routes";

import { useTranslation } from "@/i18n";

export function EmailsPage() {
  const { t } = useTranslation("logs");
  const cloudGate = useCloudGate();
  const assistantId = useActiveAssistantId();

  if (cloudGate === "gated") {
    return <Navigate replace to={routes.logs.root} />;
  }

  if (cloudGate === "disabled") {
    return (
      <CloudLoginNotice>
        {t("emailsPage.platformLoginNotice")}
      </CloudLoginNotice>
    );
  }

  return <EmailsTab assistantId={assistantId} cloudGate={cloudGate} />;
}
