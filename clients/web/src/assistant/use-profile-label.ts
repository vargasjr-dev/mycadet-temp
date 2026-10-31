import { useQuery } from "@tanstack/react-query";

import { useStickyProfiles } from "@/assistant/use-sticky-profiles";
import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

/**
 * The display label of an inference profile key for the active assistant,
 * falling back to the key while the config has not loaded or the profile is
 * gone. Shares the daemon-config query the composer already holds.
 */
export function useProfileLabel(profileKey: string | undefined): string {
  const assistantId = useActiveAssistantId();
  const configQuery = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId && !!profileKey,
    staleTime: 30_000,
  });
  const { profiles } = useStickyProfiles(
    configQuery.data?.llm,
    assistantId ?? undefined,
  );
  if (!profileKey) {
    return "";
  }
  return profiles[profileKey]?.label ?? profileKey;
}
