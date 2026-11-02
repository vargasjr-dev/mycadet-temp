import type { LockfileAssistant } from "../../lockfile-contract";
import type { MachinePlanResult } from "../../operations/machine-plan";

/**
 * The local topology's plan leg: there is no live value to diff — the
 * policy is a process hint the runtime derives at each worker spawn. The
 * plan says so, and never asks for a restart: the next spawn picks the
 * stored policy up on its own.
 */
export async function machinePlanLocal(
  entry: LockfileAssistant,
): Promise<MachinePlanResult> {
  const stored = entry.machine?.memory;
  return {
    ok: true,
    cloud: entry.cloud,
    stored,
    applied: undefined,
    changes: [],
    requiresRecreate: false,
    note: stored
      ? "no live value to diff — the stored policy is a process hint that takes effect at the next worker spawn"
      : "no policy stored; worker memory is derived from the machine's total at each spawn",
  };
}
