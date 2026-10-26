import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  assistantsDomainsListOptions,
  assistantsDomainsListQueryKey,
  assistantsEmailAddressesListOptions,
  assistantsEmailAddressesListQueryKey,
  assistantsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { useCloudAssistantId } from "@/hooks/use-cloud-assistant-id";
import { useActiveAssistantIsCloudHosted } from "@/assistant/hosting";
import { useEnvironmentStore } from "@/stores/environment-store";

import { resolveInboxStatus, type InboxStatus } from "../resolve-inbox-status";

export interface AssistantInboxState {
  status: InboxStatus;
  /** The id the cloud's assistant routes key on; `null` until resolved. */
  cloudAssistantId: string | null;
  /** The assistant as the cloud lists it; falls back to the name given. */
  assistantName: string;
  /** The public handle, which is the subdomain of the address. */
  handle: string;
  /**
   * When the cloud made the assistant, as an ISO instant; `null` until
   * the listing has answered. What says whether a user was here before a
   * feature landed.
   */
  createdAt: string | null;
  /** Whether a domain row exists already, so setup knows what to create. */
  hasDomain: boolean;
  /** The registered address, once there is one. */
  address: string | null;
  /** Its platform id, which the usage endpoint keys on. */
  addressId: string | null;
  rootDomain: string;
  /** Re-read the address and domain lists, after setup registers them. */
  refreshAddresses: () => Promise<void>;
}

/**
 * Everything the inbox needs to know to pick a state, read from the caches
 * that own it: the active assistant's hosting, the cloud's assistant
 * listing (for the handle and name), and the assistant's address and
 * domain lists. Managed email lives on the cloud API, whose assistant
 * routes key on the cloud UUID, so the local id is resolved to that
 * first; the reads that need it wait on it.
 */
export function useAssistantInboxState(
  assistantId: string | null,
  fallbackName: string,
): AssistantInboxState {
  const queryClient = useQueryClient();
  const isCloudHosted = useActiveAssistantIsCloudHosted();
  const onPlatform = isCloudHosted && !!assistantId;
  const rootDomain = useEnvironmentStore.use.emailRootDomain();

  const { cloudAssistantId } = useCloudAssistantId(assistantId, onPlatform);

  const assistantsQuery = useQuery({
    ...assistantsListOptions(),
    enabled: onPlatform,
  });
  const listed =
    assistantsQuery.data?.results?.find(
      (candidate) => candidate.id === cloudAssistantId,
    ) ?? assistantsQuery.data?.results?.[0];

  const addressPath = { path: { assistant_id: cloudAssistantId ?? "" } };
  const readsEnabled = onPlatform && !!cloudAssistantId;

  const addressesQuery = useQuery({
    ...assistantsEmailAddressesListOptions(addressPath),
    enabled: readsEnabled,
  });
  const domainsQuery = useQuery({
    ...assistantsDomainsListOptions(addressPath),
    enabled: readsEnabled,
  });

  const addresses = addressesQuery.data?.results;
  const domain = domainsQuery.data?.results?.[0];

  const refreshAddresses = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: assistantsEmailAddressesListQueryKey(addressPath),
      }),
      queryClient.invalidateQueries({
        queryKey: assistantsDomainsListQueryKey(addressPath),
      }),
    ]);
    // The query key above is built from the id, so a change of assistant
    // rebuilds it; the callback only needs the id itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, cloudAssistantId]);

  return {
    status: !onPlatform
      ? "unavailable"
      : resolveInboxStatus({
          cloudAssistantId,
          addressCount: addresses?.length,
          domainsSettled: domainsQuery.isFetched,
        }),
    cloudAssistantId,
    assistantName: listed?.name || fallbackName,
    handle: domain?.subdomain ?? listed?.handle ?? "",
    createdAt: listed?.created ?? null,
    hasDomain: !!domain,
    address: addresses?.[0]?.address ?? null,
    addressId: addresses?.[0]?.id ?? null,
    rootDomain,
    refreshAddresses,
  };
}
