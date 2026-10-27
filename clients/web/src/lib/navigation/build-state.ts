import { isLocalClient } from "@/lib/local-mode";
import {
  isSelectedAssistantOnboarded,
  userHasOnboardedAssistant,
} from "@/assistant/onboarded-assistant";
import { readSelectedAssistantId } from "@/assistant/selected-assistant-storage";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export interface NavigationState {
  isLocalClient: boolean;
  hasAssistants: boolean;
  /**
   * Whether the user owns ANY assistant past first-run onboarding, i.e. is a
   * returning user. The right question for post-auth and the onboarding
   * intercept, where the assistant they will land in is not yet known.
   */
  userHasOnboardedAssistant: boolean;
  /**
   * Whether the SELECTED assistant is past first-run onboarding. False when
   * nothing is selected. The right question for the privacy funnel, which is
   * always about one assistant.
   */
  selectedAssistantOnboarded: boolean;
}

export function buildNavigationState(): NavigationState {
  const { assistants } = useResolvedAssistantsStore.getState();
  // The persisted key rather than the store slice: this runs inside route
  // middleware, before the store has necessarily reconciled a selection.
  const selectedAssistantId = readSelectedAssistantId();
  return {
    isLocalClient: isLocalClient(),
    hasAssistants: assistants.length > 0,
    userHasOnboardedAssistant: userHasOnboardedAssistant(assistants),
    selectedAssistantOnboarded: isSelectedAssistantOnboarded(
      assistants,
      selectedAssistantId,
    ),
  };
}
