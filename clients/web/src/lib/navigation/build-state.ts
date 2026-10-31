import { isLocalClient } from "@/lib/local-mode";
import {
  isSelectedAssistantOnboarded,
  userHasOnboardedAssistant,
} from "@/assistant/onboarded-assistant";
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

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
  const assistant = useResolvedAssistantStore.getState().assistant;
  return {
    isLocalClient: isLocalClient(),
    hasAssistants: assistant !== null,
    userHasOnboardedAssistant: userHasOnboardedAssistant(assistant),
    selectedAssistantOnboarded: isSelectedAssistantOnboarded(assistant),
  };
}
