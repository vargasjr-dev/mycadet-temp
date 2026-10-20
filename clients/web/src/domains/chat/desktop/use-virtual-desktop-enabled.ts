import { useActiveAssistantIsCloudHosted } from "@/hooks/use-cloud-gate";

export function useVirtualDesktopEnabled(): boolean {
  return useActiveAssistantIsCloudHosted();
}
