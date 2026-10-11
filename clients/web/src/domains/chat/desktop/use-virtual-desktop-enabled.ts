import { useActiveAssistantIsCloudHosted } from "@/hooks/use-cloud-gate";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

export function useVirtualDesktopEnabled(): boolean {
  const enabled = useAssistantFeatureFlagStore.use.assistantDesktop();
  const cloudHosted = useActiveAssistantIsCloudHosted();
  return enabled === true && cloudHosted;
}
