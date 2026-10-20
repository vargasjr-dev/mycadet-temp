import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { BillingUsagePanel } from "@/domains/settings/components/billing-usage/billing-usage-panel";
import { UsageTab } from "@/domains/settings/billing/usage/usage-tab";
import { useCloudGate } from "@/hooks/use-cloud-gate";

/**
 * The settings usage page: the active assistant's usage trends and per-call
 * breakdowns, plus the cloud-usage chart when the platform is reachable. A
 * plain page — no billing sub-tab. Billing management moved off web (the
 * cloud's account pages own it now; how users reach those from the client is
 * its own piece of work), so this page carries no billing machinery of its
 * own.
 */
export function UsagePage() {
  const assistantId = useActiveAssistantId();
  const chartGate = useCloudGate({ cloudHostedOnly: true });
  const reachabilityGate = useCloudGate();
  const showChart = chartGate === "full" && reachabilityGate !== "gated";

  return (
    <div className="space-y-4">
      {showChart && <BillingUsagePanel />}
      <UsageTab assistantId={assistantId} />
    </div>
  );
}
