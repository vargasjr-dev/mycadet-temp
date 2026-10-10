/**
 * Record that an assistant finished first-run onboarding on the device
 * record, so a returning user skips the first-run flow in every hosting mode.
 */

import { markAssistantOnboarded } from "@/domains/onboarding/onboarded-assistant-record";

/** No-ops on a null id: a dead hatch has nothing to record. */
export function stampAssistantOnboarded(
  assistantId: string | null | undefined,
): void {
  if (!assistantId) {
    return;
  }
  markAssistantOnboarded(assistantId, new Date().toISOString());
}
