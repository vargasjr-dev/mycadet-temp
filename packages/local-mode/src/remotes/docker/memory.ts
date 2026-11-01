import type { MachineMemoryPolicy } from "../../lockfile-contract";

/**
 * How a stored memory policy materializes as `docker run` flags on the
 * ASSISTANT container — the one definition the create path (via
 * `buildServiceRunArgs`) and `machine plan`'s projected materialization
 * share, so plan can never disagree with what apply would do.
 *
 * Only PINNED fields emit flags: a policy with just `high` emits only the
 * reservation (no hard cap); the swap pin exists solely to keep docker's
 * 2× default from silently doubling the envelope, so it rides `max` and is
 * never emitted alone. Unset policy emits nothing — the container runs
 * unlimited, exactly as it always has.
 */
export function machineMemoryRunArgs(
  policy: MachineMemoryPolicy | null | undefined,
): string[] {
  if (!policy) return [];
  const args: string[] = [];
  if (policy.max !== undefined) {
    args.push("--memory", String(policy.max));
    args.push("--memory-swap", String(policy.max));
  }
  if (policy.high !== undefined) {
    args.push("--memory-reservation", String(policy.high));
  }
  return args;
}
