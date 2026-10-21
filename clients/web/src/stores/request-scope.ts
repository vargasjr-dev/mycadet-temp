/**
 * The identity every request is made under, read the two ways consumers
 * need it: imperatively for sequences that run outside React, and
 * reactively for components.
 *
 * `AppProviders` keys the request-scoped `QueryClient` on this string, so
 * anything that outlives a render and later writes into that cache (a redirect
 * return resolving across a full page load, say) can compare the scope it
 * started under against the scope in hand and drop a result the identity now
 * on screen never asked for.
 *
 * The identity is the gateway session seam's: live-or-not plus the
 * assistant/guardian key — the platform user id is gone from this bundle.
 */
import {
  useGatewaySessionStore,
  useIsGatewaySessionLive,
} from "@/stores/gateway-session-store";
import {
  getActiveOrganizationIdForRequests,
  useRequestOrganizationId,
} from "@/stores/organization-store";
import { requestScopeKey } from "@/utils/request-scope-key";

/**
 * The scope a request made right now would carry.
 *
 * The organization comes from `getActiveOrganizationIdForRequests()`, the same
 * derivation that builds `Cadet-Organization-Id`, so the key names whoever
 * the server actually answered for. The seam's resolved key alone would not:
 * it is null while the persisted id is carrying requests, which stamps an
 * organization's response as belonging to no organization at all.
 */
export function currentRequestScopeKey(): string {
  const { live, identityKey } = useGatewaySessionStore.getState();
  return requestScopeKey({
    isAuthenticated: live,
    userId: identityKey,
    organizationId: getActiveOrganizationIdForRequests(),
  });
}

/** Subscribe to {@link currentRequestScopeKey}. */
export function useRequestScopeKey(): string {
  const authenticated = useIsGatewaySessionLive();
  const identityKey = useGatewaySessionStore.use.identityKey();
  const organizationId = useRequestOrganizationId();
  return requestScopeKey({
    isAuthenticated: authenticated,
    userId: identityKey,
    organizationId,
  });
}
