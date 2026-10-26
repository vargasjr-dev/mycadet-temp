import { useAuthStore } from "@/stores/auth-store";
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
  return {
    isLocalClient: isLocalClient(),
    isRemoteGateway,
    remoteGatewayPublicPathPrefix: isRemoteGateway
      ? remoteGatewayPublicPathPrefix()
      : "",
    isGatewaySessionLive: isGatewaySessionLive(),
    hasAssistants: assistants.length > 0,
    cloudSession,
    userHasOnboardedAssistant: userHasOnboardedAssistant(assistants),
    selectedAssistantOnboarded: isSelectedAssistantOnboarded(
      assistants,
      selectedAssistantId,
    ),
    ...overrides,
  };
}
