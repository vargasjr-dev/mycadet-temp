import type { AuthUser } from "@/stores/auth-store";

/**
 * Whether a session belongs to Cadet staff.
 *
 * The platform's `isStaff` bit is the primary signal. A `@mycadet.ai` address
 * is the fallback for sessions whose snapshot carries no staff bit. Local
 * gateway sessions have neither, so they are never staff.
 *
 * Every staff-gated affordance reads this one predicate, so widening or
 * narrowing who counts as staff moves all of them together.
 */
export function isCadetStaff(user: AuthUser | null): boolean {
  return (
    user?.isStaff === true ||
    user?.email?.toLowerCase().endsWith("@mycadet.ai") === true
  );
}
