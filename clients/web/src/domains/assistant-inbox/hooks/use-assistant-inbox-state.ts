import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  useMailDomains,
  useMailEmailAddresses,
  mailKeys,
} from "@/lib/mail-api";
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

  const addressesQuery = useMailEmailAddresses(assistantId);
  const domainsQuery = useMailDomains(assistantId);

  const addresses = addressesQuery.data;
  const domain = domainsQuery.data?.[0];

  const refreshAddresses = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: mailKeys.emailAddresses(assistantId),
      }),
      queryClient.invalidateQueries({
        queryKey: mailKeys.domains(assistantId),
      }),
    ]);
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
