import { useMutation } from "@tanstack/react-query";

import { connectLocalAssistant } from "@/assistant/connect-assistant";
import { loadLockfile } from "@/lib/local-mode";
import { upgradeLocalAssistantHost } from "@/runtime/local-mode-host";

interface UseLocalRuntimeUpgradeOptions {
  assistantId: string | null;
  targetVersion?: string;
}

export function useLocalRuntimeUpgrade({
  assistantId,
  targetVersion,
}: UseLocalRuntimeUpgradeOptions) {
  const mutation = useMutation({
    mutationFn: async () => {
      if (!assistantId) {
        throw new Error("No local assistant is active.");
      }
      const result = await upgradeLocalAssistantHost(assistantId, {
        ...(targetVersion ? { version: targetVersion } : { latest: true }),
      });
      if (!result.ok) {
        throw new Error(result.error ?? "Failed to trigger update.");
      }
      return result;
    },
  });

  return {
    ...mutation,
    upgrade: async () => {
      if (!assistantId) {
        throw new Error("No local assistant is active.");
      }
      const result = await mutation.mutateAsync();
      await loadLockfile();
      await connectLocalAssistant(assistantId);
      return result;
    },
  };
}
