import { useAuthStore } from "@/stores/auth-store";
import { isSessionSettled, isAuthenticated } from "@/stores/session-status";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
import { isLocalClient, isServedGatewayRuntime } from "@/lib/local-mode";
import {
  readHasConsentRecord,
  readTosAccepted,
  readPrivacyConsent,
  readConsentHydrated,
} from "@/domains/onboarding/prefs";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";
import {
  isSelectedAssistantOnboarded,
  userHasOnboardedAssistant,
} from "@/domains/onboarding/onboarded-assistant";
import { readSelectedAssistantId } from "@/assistant/selected-assistant-storage";
import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import type { NavigationState } from "./navigation-resolver";

/**
 * Whether the active organization has a cloud-hosted assistant — the only
 * kind a cloud plan can apply to.
 *
 * The org narrows the list only once it resolves. Before that every resolved
 * assistant counts: narrowing against an unresolved org would read an
 * established user's own cloud assistant as absent (lockfile entries carry
 * an `organizationId`, and `assistantsValidForOrg` drops those that name a
 * different one).
 */
function hasCloudHostedAssistant(assistants: ResolvedAssistant[]): boolean {
  const activeOrganizationId = getActiveOrganizationIdForRequests();
  const scoped =
    activeOrganizationId == null
      ? assistants
      : assistantsValidForOrg(assistants, activeOrganizationId);
  return scoped.some((assistant) => assistant.isCloudHosted);
}

export function buildNavigationState(
  overrides?: Partial<NavigationState>,
): NavigationState {
  const { sessionStatus, cloudSession } = useAuthStore.getState();
  const { assistants, assistantsHydrated } =
    useResolvedAssistantsStore.getState();
  // The persisted key rather than the store slice: this runs inside route
  // middleware, before the store has necessarily reconciled a selection.
  const selectedAssistantId = readSelectedAssistantId();
  const isRemoteGateway = isServedGatewayRuntime();
  return {
    isLocalClient: isLocalClient(),
    isRemoteGateway,
    remoteGatewayPublicPathPrefix: isRemoteGateway
      ? remoteGatewayPublicPathPrefix()
      : "",
    isGatewayAuth: isGatewayAuthMode(),
    hasAssistants: assistants.length > 0,
    hasCloudHostedAssistant: hasCloudHostedAssistant(assistants),
    sessionSettled: isSessionSettled(sessionStatus),
    // `isAuthenticated` mirrors `sessionStatus`. The local gateway is the sole
    // session authority (#35152), so a reachable local user is already
    // `"authenticated"` — a cloud `getSession()` 401 drops only
    // `cloudSession`, never `sessionStatus` (see `probeCloudSession`).
    // Reading the one source keeps this from drifting from `useIsAuthenticated()`.
    isAuthenticated: isAuthenticated(sessionStatus),
    cloudSession,
    tosAccepted: readTosAccepted(),
    hasConsentRecord: readHasConsentRecord(),
    privacyConsent: readPrivacyConsent(),
    consentHydrated: readConsentHydrated(),
    assistantsHydrated,
    userHasOnboardedAssistant: userHasOnboardedAssistant(assistants),
    selectedAssistantOnboarded: isSelectedAssistantOnboarded(
      assistants,
      selectedAssistantId,
    ),
    ...overrides,
  };
}
