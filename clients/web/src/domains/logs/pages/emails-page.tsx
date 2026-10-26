import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { EmailsTab } from "@/domains/logs/components/emails-tab";
import {
  useActiveAssistantIsCloudHosted,
  useActiveAssistantIsSelfHosted,
} from "@/assistant/hosting";
import { routes } from "@/utils/routes";

export function EmailsPage() {
  const assistantId = useActiveAssistantId();
  const isSelfHosted = useActiveAssistantIsSelfHosted();
  const isCloudHosted = useActiveAssistantIsCloudHosted();

  if (isSelfHosted) {
    return <Navigate replace to={routes.logs.root} />;
  }

  return <EmailsTab assistantId={assistantId} isCloudHosted={isCloudHosted} />;
}
