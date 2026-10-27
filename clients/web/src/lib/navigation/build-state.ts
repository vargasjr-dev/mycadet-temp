import { isLocalClient } from "@/lib/local-mode";
import {
  isSelectedAssistantOnboarded,
  userHasOnboardedAssistant,
} from "@/assistant/onboarded-assistant";
import { readSelectedAssistantId } from "@/assistant/selected-assistant-storage";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CloudSessionAnswer } from "@/stores/auth-store";
import type { NavigationState } from "./navigation-resolver";

/**
 * Assemble the navigation state. The cloud-session answer is a required
 * input, not a store read: the auth store carries no session state, and the
 * callers that branch on the answer (the middleware's local fork,
 * post-retire) await the probe before deciding, while the callers whose
 * query never reads it pass the factual answer for their page.
 */
export function buildNavigationState(
  cloudSession: CloudSessionAnswer,
): NavigationState {
  const { assistants } = useResolvedAssistantsStore.getState();
  // The persisted key rather than the store slice: this runs inside route
  // middleware, before the store has necessarily reconciled a selection.
  const selectedAssistantId = readSelectedAssistantId();
  return {
    isLocalClient: isLocalClient(),
    hasAssistants: assistants.length > 0,
    cloudSession,
    userHasOnboardedAssistant: userHasOnboardedAssistant(assistants),
    selectedAssistantOnboarded: isSelectedAssistantOnboarded(
      assistants,
      selectedAssistantId,
    ),
  };
}
