/**
 * Personality slider sidecar path and the five 0-100 axis ids.
 *
 * The web writes `data/personality-sliders.json` so the sliders reopen where
 * the user left them. Both sides import these constants from
 * `@mycadet/assistant-api` so the ids cannot drift.
 */

/** Workspace-relative sidecar holding the five 0-100 slider values. */
export const PERSONALITY_SLIDERS_PATH = "data/personality-sliders.json";

/** Sliders start centered. */
export const PERSONALITY_SLIDER_DEFAULT = 50;

/**
 * Axis ids the personality sliders key their values by. Each is 0-100 with
 * 0 = the left label and 100 = the right label.
 */
export const PERSONALITY_AXIS_IDS = {
  companionCoworker: "companion-coworker",
  genzBoomer: "genz-boomer",
  executeCollaborate: "execute-collaborate",
  playfulSerious: "playful-serious",
  politeUnfiltered: "polite-unfiltered",
} as const;

export type PersonalityAxisId =
  (typeof PERSONALITY_AXIS_IDS)[keyof typeof PERSONALITY_AXIS_IDS];
