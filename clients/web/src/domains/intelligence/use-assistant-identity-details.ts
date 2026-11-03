/**
 * Identity details for the About Assistant pages: the daemon's `/identity`
 * document (name, role, personality) plus the assistant record's creation
 * date ("hatched"). Shared through React Query so the overview and the
 * personality page read one cached result, and identity rewrites (rename,
 * personality update) can invalidate it for every consumer.
 */

import { useQuery } from "@tanstack/react-query";

import { getResolvedAssistant } from "@/stores/resolved-assistant-store";
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
      // The created stamp lives on the resolved assistant's entry — the
      // store's read replaces the platform round trip.
      const entry = getResolvedAssistant();
      const createdAt =
        entry.assistantId === assistantId ? (entry.hatchedAt ?? null) : null;
      return { identity, createdAt };
    },
  });
}
