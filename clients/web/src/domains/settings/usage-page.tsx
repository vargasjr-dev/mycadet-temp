import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { UsageTab } from "@/domains/settings/usage/usage-tab";

/**
 * The settings usage page: the active assistant's usage trends and per-call
 * breakdowns. A plain page — no billing sub-tab; billing management lives
 * on the cloud's account pages.
 */
export function UsagePage() {
  const assistantId = useActiveAssistantId();

  return <UsageTab assistantId={assistantId} />;
}
