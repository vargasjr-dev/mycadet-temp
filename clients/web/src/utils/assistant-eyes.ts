/**
 * Shared sizing for the assistant's eye sprite wherever it perches inside a
 * nav row — the sidebar's assistant cluster and the onboarding tour's
 * flooded rows render the same eyes, so they draw from one set of numbers.
 */

/**
 * Hand-tuned base (unscaled) sprite width per eye style — the catalog is a
 * handful of shapes whose aspect ratios vary too wildly (gentle ≈ 1.1 wide
 * per tall, grumpy ≈ 4.6) for one derived formula to size them all well.
 * Height follows each style's own aspect ratio at its width; the resting
 * eyes render at {@link REST_SCALE} times these. Styles missing from the
 * map (a future catalog addition) fall back to {@link DEFAULT_EYES_WIDTH}.
 */
export const EYE_STYLE_WIDTHS: Record<string, number> = {
  grumpy: 22,
  angry: 14,
  curious: 14,
  goofy: 12,
  surprised: 15,
  bashful: 15,
  gentle: 11,
  quirky: 12,
  dazed: 16,
};
export const DEFAULT_EYES_WIDTH = 14;

/** Base (unscaled) sprite width for an eye style. */
export function eyeStyleBaseWidth(styleId: string): number {
  return EYE_STYLE_WIDTHS[styleId] ?? DEFAULT_EYES_WIDTH;
}
