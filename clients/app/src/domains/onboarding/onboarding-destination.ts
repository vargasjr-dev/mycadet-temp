import { routes } from "@app/utils/routes";

/**
 * Query param marking a funnel walk that is provisioning a NEW assistant. Set
 * by every handoff into a funnel screen that provisions: the start screen's
 * CTA, the hosting screen's cloud Continue, the api-key screen, and the retry
 * off-ramp on a failed managed hatch.
 *
 * The walk's intent, which no fact about an existing assistant can supply: the
 * one being created does not exist yet, so however established the selected
 * assistant is, this visit is its first run. The funnel route guards and the
 * post-consent destination both defer to the marker rather than skipping a
 * hatch the user explicitly asked for.
 */
export const NEW_ASSISTANT_PARAM = "new_assistant";

/** Whether a funnel URL carries the {@link NEW_ASSISTANT_PARAM} marker. */
export function isNewAssistantFunnel(
  searchParams: Pick<URLSearchParams, "get">,
): boolean {
  return searchParams.get(NEW_ASSISTANT_PARAM) === "1";
}

/**
 * Decide where the standard onboarding flow goes after consent settles (the
 * shell's /account/consent screen, or the api-key screen's continue for a
 * walk that already consented).
 *
 * The research/personality flow is now THE onboarding, but HOW the assistant is
 * provisioned differs by hosting:
 *
 * - **Platform / Cadet-Cloud** → straight to `/assistant/onboarding/research`,
 *   which runs its own managed background hatch and walks the user to chat.
 * - **Local hosting** (`hosting=local`/`docker` in a local-mode build) → the
 *   `hatching` screen first, so the FOREGROUND local hatch (daemon spawn →
 *   gateway readyz → provider key) runs; the hatching screen then redirects into
 *   the research flow, which adopts that just-hatched assistant. Skipping
 *   hatching here would leave the research flow with no assistant to adopt.
 * - **Selected assistant already onboarded** → `/assistant`. That assistant is
 *   provisioned and past research, including in production. Yields to a walk
 *   that is provisioning a new assistant: that one does not exist yet, so the
 *   selected assistant cannot answer for it.
 */
export function onboardingDestinationAfterConsent({
  isLocalHatch,
  selectedAssistantOnboarded = false,
  newAssistant = false,
}: {
  /** A local-hosting onboarding that must run the foreground local hatch. */
  isLocalHatch: boolean;
  /**
   * The selected assistant has already finished first-run onboarding. Skips
   * research on every build, including production.
   */
  selectedAssistantOnboarded?: boolean;
  /**
   * This walk is provisioning a new assistant (see {@link NEW_ASSISTANT_PARAM}),
   * so it must reach a hatch rather than short-circuit to an existing one.
   */
  newAssistant?: boolean;
}): string {
  // `isLocalHatch` counts as provisioning on its own: it names a foreground
  // hatch that has to run, marker or not.
  if (selectedAssistantOnboarded && !newAssistant && !isLocalHatch) {
    return routes.assistant;
  }
  return isLocalHatch ? routes.onboarding.hatching : routes.onboarding.research;
}
