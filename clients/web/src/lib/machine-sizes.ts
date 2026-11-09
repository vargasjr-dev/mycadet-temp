import type { MachineSizeEnum } from "@/generated/operator/types.gen";
/**
 * Pro tier ceilings → machine sizes the org may run at within that tier.
 * Keys mirror `BillingAccount.max_machine_tier` ("medium" | "large" | "xl");
 * values are `MachineSizeEnum` strings sent to the resize mutation.
 */
export const TIER_TO_SIZES: Record<string, MachineSizeEnum[]> = {
  medium: ["small", "medium"],
  large: ["small", "medium", "large"],
  xl: ["small", "medium", "large", "extra_large"],
};

/**
 * Allowed machine sizes for an org's tier, in ascending order. A null/undefined
 * or unrecognized tier returns an empty list — callers must handle the empty
 * case (e.g. a "no tier configured" warning) rather than silently defaulting to
 * a tier the org may not actually have.
 *
 * Accepts a plain string because the generated `max_machine_tier` field is
 * typed `string | null`; unknown values fall through to the empty list.
 */
export function allowedMachineSizesForTier(
  tier: string | null | undefined,
): MachineSizeEnum[] {
  return tier ? (TIER_TO_SIZES[tier] ?? []) : [];
}

export const SIZE_LABEL: Record<MachineSizeEnum, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  extra_large: "Extra Large",
};
// Descriptions reflect the cpu_limit / memory_limit from
// the cloud api's domain constants,
// rounded to integers where the underlying value is a whole number of cores
// (e.g. small's 2000m CPU limit displays as 2 vCPU). Keep these in sync if
// the backend presets change.
export const SIZE_DESCRIPTION: Record<MachineSizeEnum, string> = {
  small: "2 vCPU, 3 GiB",
  medium: "2.5 vCPU, 5 GiB",
  large: "4 vCPU, 8 GiB",
  extra_large: "4 vCPU, 16 GiB",
};

/**
 * Canonical small→large ordering used to bound selection and disable
 * downsizes. Index into this to compare two `MachineSizeEnum` values.
 */
export const MACHINE_SIZE_ORDER: MachineSizeEnum[] = [
  "small",
  "medium",
  "large",
  "extra_large",
];

/** Rank of a machine size in the small→large ordering. */
export function machineSizeRank(size: MachineSizeEnum): number {
  return MACHINE_SIZE_ORDER.indexOf(size);
}

/**
 * The size the server settles a package that names no machine tier at, and so
 * the ceiling it caps such a package's pod to.
 */
export const MACHINE_FLOOR_SIZE: MachineSizeEnum = "small";

/**
 * The largest size a tier permits: the ceiling the server caps a pod to. Null
 * when the tier names no machine, or is one this bundle doesn't recognize.
 */
export function machineCeilingForTier(
  tier: string | null | undefined,
): MachineSizeEnum | null {
  return allowedMachineSizesForTier(tier).at(-1) ?? null;
}

/**
 * Whether moving between two machine tiers can force the pod to shrink: the
 * ceiling it is headed for ranks below the one it is leaving.
 *
 * A tier of null names no machine, so it resolves to the floor the server caps
 * such a package to. A non-null tier this bundle cannot rank resolves to
 * nothing at all, and reads as able to shrink: a move that can't be ranked must
 * not be granted the inference that only a raise has earned.
 */
export function lowersMachineCeiling(
  fromTier: string | null | undefined,
  toTier: string | null | undefined,
): boolean {
  const from = tierCeilingRank(fromTier);
  const to = tierCeilingRank(toTier);
  if (from == null || to == null) {
    return true;
  }
  return to < from;
}

function tierCeilingRank(tier: string | null | undefined): number | null {
  if (tier == null) {
    return machineSizeRank(MACHINE_FLOOR_SIZE);
  }
  const ceiling = machineCeilingForTier(tier);
  return ceiling == null ? null : machineSizeRank(ceiling);
}
