import { useAuthStore } from "@/stores/auth-store";
import { isSessionSettled, isAuthenticated } from "@/stores/session-status";
import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
import {
  isGatewaySessionLive,
  isLocalClient,
  isServedGatewayRuntime,
} from "@/lib/local-mode";
import {
  readHasConsentRecord,
  readTosAccepted,
  readPrivacyConsent,
  readConsentHydrated,
} from "@/domains/onboarding/prefs";
import {
  isSelectedAssistantOnboarded,
  userHasOnboardedAssistant,
} from "@/domains/onboarding/onboarded-assistant";
import { readSelectedAssistantId } from "@/assistant/selected-assistant-storage";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { NavigationState } from "./navigation-resolver";

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
    isGatewaySessionLive: isGatewaySessionLive(),
    hasAssistants: assistants.length > 0,
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
