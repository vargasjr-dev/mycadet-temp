/**
 * Consolidates onboarding state, refs, and effects that previously lived
 * as scattered pieces in ActiveChatView.
 *
 * Owns:
 * - `pendingOnboardingContextRef` — pre-chat context for the first send
 * - `onboardingDraftConversationIdRef` — draft conversation created during onboarding
 * - `didOnboarding` / `onboardingConversationId` / `onboardingChoiceEligible` — lifecycle flags
 * - `?onboarding=1` search-param signal consumption effect
 * - choice-card eligibility derivation from the pending pre-chat context
 *
 * Does NOT own:
 * - Auto-send of the initial message (depends on `sendMessage` from `useSendMessage`,
 *   which itself consumes the refs this hook creates — keeping auto-send here
 *   would create a circular initialization dependency)
 * - Reachability probe (same reason — depends on reachability from a sibling hook)
 *
 * Returns:
 * - Refs consumed by `useSendMessage` and `useConversationLoader` (shared ownership)
 * - Flags consumed by `ChatMainPanel` via props
 */

import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import {
  peekPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/chat/prechat";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { routes } from "@/utils/routes";

export interface UseOnboardingOrchestratorResult {
  /** Whether the user arrived via the onboarding flow. */
  didOnboarding: boolean;
  /**
   * Whether this onboarding handoff is eligible for the in-chat onboarding
   * choice card. See the option doc on `useOnboardingChoice` for the
   * rationale behind each condition.
   */
  onboardingChoiceEligible: boolean;
  /** The draft conversation created for the onboarding flow. */
  onboardingConversationId: string | null;
  /** Shared with `useSendMessage` — pre-chat context for the first send. */
  pendingOnboardingContextRef: MutableRefObject<PreChatOnboardingContext | null>;
  /** Shared with `useSendMessage` + `useConversationLoader`. */
  onboardingDraftConversationIdRef: MutableRefObject<string | null>;
}

export function useOnboardingOrchestrator(): UseOnboardingOrchestratorResult {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const pendingOnboardingContextRef = useRef<PreChatOnboardingContext | null>(
    null,
  );
  const onboardingDraftConversationIdRef = useRef<string | null>(null);
  const [didOnboarding, setDidOnboarding] = useState(false);
  const [onboardingChoiceEligible, setOnboardingChoiceEligible] =
    useState(false);
  const [onboardingConversationId, setOnboardingConversationId] = useState<
    string | null
  >(null);

  // Consume the `?onboarding=1` signal left by `/onboarding/hatching` when
  // it forwards the user after a successful hatch. Owns the post-hatch
  // draft conversation creation + redirect; the auto-greet gate itself
  // is driven by the auto-greet store (set by the
  // hatching screens before they navigate). The flag is stripped from
  // the URL immediately so a page refresh doesn't re-trigger the greet.
  useEffect(() => {
    if (searchParams.get("onboarding") !== "1") {
      return;
    }
    setDidOnboarding(true);
    const draftId =
      onboardingDraftConversationIdRef.current ?? createDraftConversationId();
    onboardingDraftConversationIdRef.current = draftId;
    setOnboardingConversationId(draftId);
    useConversationStore.getState().setActiveConversationId(draftId);
    void navigate(routes.conversation(draftId), { replace: true });
  }, [searchParams, navigate]);

  // Derive choice-card eligibility from the pending pre-chat context. Runs
  // once on mount, before the first send consumes the context. Reads through
  // the validated peek so this gate can never disagree with the auto-send
  // path in ActiveChatView: a malformed/absent context yields `null` there
  // too, which fails open to the legacy (card-less) behavior.
  useEffect(() => {
    const ctx = peekPendingPreChatContext();
    if (
      ctx !== null &&
      ctx.tasks.length === 0 &&
      ctx.initialMessageHidden !== true
    ) {
      setOnboardingChoiceEligible(true);
    }
  }, []);

  return {
    didOnboarding,
    onboardingChoiceEligible,
    onboardingConversationId,
    pendingOnboardingContextRef,
    onboardingDraftConversationIdRef,
  };
}
