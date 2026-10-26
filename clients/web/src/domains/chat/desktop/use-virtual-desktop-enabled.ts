import { useActiveAssistantIsCloudHosted } from "@/assistant/hosting";

export function useVirtualDesktopEnabled(): boolean {
  return useActiveAssistantIsCloudHosted();
}
