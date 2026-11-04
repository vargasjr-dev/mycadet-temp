import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  assistantsDomainsListOptions,
  assistantsDomainsListQueryKey,
  assistantsEmailAddressesListOptions,
  assistantsEmailAddressesListQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { getResolvedAssistant } from "@/stores/resolved-assistant-store";
import { useEnvironmentStore } from "@/stores/environment-store";

import { resolveInboxStatus, type InboxStatus } from "../resolve-inbox-status";

export interface AssistantInboxState {
  status: InboxStatus;
  /** The assistant id the routes key on. */
  assistantId: string;
  /** The assistant as the store lists it; falls back to the name given. */
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
 * that own it: the store's entry (for the handle and name — the inbox IS
 * the active assistant's inbox, so there is nothing to scan a listing
 * for) and the assistant's address and domain lists. Managed email lives
 * on the platform API, whose assistant routes key on the assistant id.
 */
export function useAssistantInboxState(
  fallbackName: string,
): AssistantInboxState {
  const queryClient = useQueryClient();
  const rootDomain = useEnvironmentStore.use.emailRootDomain();

  // The store IS the cloud's record of this assistant — its name, handle,
  // id, and creation instant come from there, not from a listing scan.
  const assistant = getResolvedAssistant();
  const assistantId = assistant.assistantId;

  const addressPath = { path: { assistant_id: assistantId } };

  const addressesQuery = useQuery({
    ...assistantsEmailAddressesListOptions(addressPath),
  });
  const domainsQuery = useQuery({
    ...assistantsDomainsListOptions(addressPath),
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
  }, [queryClient, assistantId]);

  return {
    status: resolveInboxStatus({
      addressCount: addresses?.length,
      domainsSettled: domainsQuery.isFetched,
    }),
    assistantId,
    assistantName: assistant.name || fallbackName,
    handle: domain?.subdomain ?? assistantId,
    createdAt: assistant.hatchedAt ?? null,
    hasDomain: !!domain,
    address: addresses?.[0]?.address ?? null,
    addressId: addresses?.[0]?.id ?? null,
    rootDomain,
    refreshAddresses,
  };
}
