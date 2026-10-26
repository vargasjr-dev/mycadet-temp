import { useAuthStore } from "@/stores/auth-store";
import { bootResolutionFact } from "@/assistant/queries";
import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
import {
  isGatewaySessionLive,
  isLocalClient,
  isServedGatewayRuntime,
} from "@/lib/local-mode";
import {
  isSelectedAssistantOnboarded,
  userHasOnboardedAssistant,
} from "@/assistant/onboarded-assistant";
import { readSelectedAssistantId } from "@/assistant/selected-assistant-storage";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { NavigationState } from "./navigation-resolver";

export function buildNavigationState(
  overrides?: Partial<NavigationState>,
): NavigationState {
  const { cloudSession } = useAuthStore.getState();
  const { assistants } = useResolvedAssistantsStore.getState();
  // The persisted key rather than the store slice: this runs inside route
  // middleware, before the store has necessarily reconciled a selection.
  const selectedAssistantId = readSelectedAssistantId();
  const isRemoteGateway = isServedGatewayRuntime();
  const boot = bootResolutionFact();
  return {
    isLocalClient: isLocalClient(),
    isRemoteGateway,
    remoteGatewayPublicPathPrefix: isRemoteGateway
      ? remoteGatewayPublicPathPrefix()
      : "",
    isGatewaySessionLive: isGatewaySessionLive(),
    hasAssistants: assistants.length > 0,
    sessionSettled: boot.settled,
    // The boot resolution answers the session question: it presents the same
    // credential a session probe would, and it 401s when that credential is
    // gone. A settled rejection (401/403/410) is the only "out"; everything
    // else — ok, a 404 for a signed-in account with nothing to resolve, a
    // transport failure — is non-authoritative (LUM-2412), so the guard
    // admits and the app's own surfaces speak for the session. In
    // gateway-auth mode the fact short-circuits true: the gateway issued the
    // session itself, so a reachable local user is always admitted here — a
    // cloud `getSession()` 401 drops only `cloudSession`, never this.
    isAuthenticated: boot.authenticated,
    cloudSession,
    userHasOnboardedAssistant: userHasOnboardedAssistant(assistants),
    selectedAssistantOnboarded: isSelectedAssistantOnboarded(
      assistants,
      selectedAssistantId,
    ),
    ...overrides,
  };
}
