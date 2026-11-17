/**
 * Identity details for the About Assistant pages: the daemon's `/identity`
 * document (name, role, personality) plus the assistant record's creation
 * date ("hatched"). Shared through React Query so the overview and the
 * personality page read one cached result, and identity rewrites (rename,
 * personality update) can invalidate it for every consumer.
 */

import { useQuery } from "@tanstack/react-query";

import { fetchAssistantIdentity } from "@/assistant/identity";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";

export interface AssistantIdentityDetails {
  identity: IdentityGetResponse | null;
  createdAt: string | null;
}

export function assistantIdentityDetailsQueryKey(assistantId: string) {
  return ["assistant-identity-details", assistantId] as const;
}

export function useAssistantIdentityDetails(assistantId: string) {
  return useQuery<AssistantIdentityDetails>({
    queryKey: assistantIdentityDetailsQueryKey(assistantId),
    queryFn: async () => {
      const [identity] = await Promise.all([
        fetchAssistantIdentity(assistantId),
      ]);
      // The created stamp lives on the assistant's identity document —
      // the same read this query already serves.
      const createdAt = identity?.createdAt ?? null;
      return { identity, createdAt };
    },
  });
}
