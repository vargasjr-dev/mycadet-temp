import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  configGetOptions,
  conversationsByIdGetOptions,
  inferenceProfilesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { InferenceProfileSummary } from "@/generated/daemon/types.gen";

/**
 * Resolves the (provider, model) pair currently in effect for a chat
 * conversation by reading the assistant's LLM config for the active-profile
 * selection and the profiles API for the effective profile body.
 *
 * The queries share their respective TanStack Query cache entries with
 * the rest of the app (settings domain, composer settings menu, etc.) so
 * invalidating any of them from a consumer also refreshes this hook's
 * derivation.
 *
 * Used by the chat composer to gate behaviors that depend on model
 * capabilities (e.g. image attachments require a vision-capable model).
 * Returns `null` when the data isn't loaded yet or the active profile
 * doesn't declare a provider/model.
 *
 * The profile body comes from `GET /inference/profiles` — the effective
 * view the daemon resolves from its model catalog — because managed
 * profiles persist in the config as thin stubs. `supportsVision` is
 * resolved server-side on that same view: the catalog's answer, with the
 * profile's `inputModalities.image` override winning.
 */
export interface ActiveProfileModel {
  provider: string;
  model: string;
  supportsVision?: boolean;
}

/**
 * @param pendingProfile Profile stashed in the composer for a conversation
 *   whose row hasn't loaded yet (a draft, or one opened by URL mid-load) — see
 *   `pendingDraftProfiles` in `conversation-store`. It's the effective profile
 *   until the row materializes, so capability gating (e.g. image attachments)
 *   should reflect it. A loaded per-conversation override still wins.
 */
export function useActiveProfileModel(
  assistantId: string | null,
  conversationId: string | undefined,
  pendingProfile?: string | null,
): ActiveProfileModel | null {
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  const { data: convData } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: !!assistantId && !!conversationId,
  });

  const { data: profilesData } = useQuery({
    ...inferenceProfilesGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  return useMemo(() => {
    const globalActive = config?.llm?.activeProfile ?? null;
    const convOverride = convData?.conversation.inferenceProfile ?? null;
    const effective = convOverride ?? pendingProfile ?? globalActive;

    if (!effective) {
      return null;
    }
    const summary: InferenceProfileSummary | undefined =
      profilesData?.profiles.find((profile) => profile.name === effective);
    if (!summary?.provider || !summary.model) {
      return null;
    }
    return {
      provider: summary.provider,
      model: summary.model,
      ...(typeof summary.supportsVision === "boolean"
        ? { supportsVision: summary.supportsVision }
        : {}),
    };
  }, [config, convData, profilesData, pendingProfile]);
}
