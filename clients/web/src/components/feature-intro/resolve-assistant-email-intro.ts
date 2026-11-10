import type { InboxStatus } from "@/domains/assistant-inbox/resolve-inbox-status";
import type { Remote } from "@mycadet/local-mode/contract";

import { predatesFeatureIntro } from "@/hooks/use-feature-intro-seen";

export interface AssistantEmailIntroInputs {
  /** The intro was dismissed on this device. */
  seen: boolean;
  /**
   * Onboarding still has the screen: the research takeover, its check-in,
   * or the in-chat tour with its capture layers and focus trap.
   */
  onboardingBusy: boolean;
  /**
   * When the cloud made the assistant, or `null` while unknown. Only an
   * assistant from before the intro shipped is owed it; a newer one meets
   * email as part of the app.
   */
  assistantCreatedAt: string | null;
  status: InboxStatus;
}

/**
 * Which intro to show, if any, from what the app knows: `locked` is the
 * design's pitch for a plan without email, `open` the one for a plan that
 * has it and an assistant with no address yet. Pure so the decision can be
 * tested without the hooks that feed it.
 *
 * Nothing shows while the reads that decide are pending, so a user is never
 * pitched an upgrade their plan already includes; nothing shows to an
 * assistant that already has an address, since the intro is news and that
 * user has it; and nothing shows to an assistant made after the launch,
 * since to them email was always there.
 */
/**
 * Whether the surface can plausibly be owed the email intro, decided from
 * the resolved assistant's boot record alone — no request. The gate's reads
 * are the cloud platform's own endpoints; off the platform they cannot be
 * answered at all (locally they 503/404), so an off-platform assistant is
 * never owed the intro. On the platform the creation instant decides: an
 * assistant that doesn't predate the intro — one with no known instant
 * included, the same ruling the resolver makes — meets email as part of
 * the app and is not pitched.
 */
export function shouldOfferAssistantEmailIntro(
  cloud: Remote,
  hatchedAt: string | null | undefined,
): boolean {
  if (cloud !== "cloud") {
    return false;
  }
  return predatesFeatureIntro(hatchedAt, "assistant-email");
}

export function resolveAssistantEmailIntro(
  inputs: AssistantEmailIntroInputs,
): "open" | null {
  if (inputs.seen) {
    return null;
  }
  if (inputs.onboardingBusy) {
    return null;
  }
  if (!predatesFeatureIntro(inputs.assistantCreatedAt, "assistant-email")) {
    return null;
  }
  return inputs.status === "setup" ? "open" : null;
}
