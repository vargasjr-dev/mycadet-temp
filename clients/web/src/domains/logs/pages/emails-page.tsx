
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { EmailsTab } from "@/domains/logs/components/emails-tab";
export function EmailsPage() {
  const assistantId = useActiveAssistantId();

  return <EmailsTab assistantId={assistantId} />;
}
