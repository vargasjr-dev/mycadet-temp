import type {
  LockfileAssistant,
  MachineMemoryPolicy,
  Remote,
} from "../lockfile-contract";
import { cliCommand } from "../environment";
import { machinePlanDocker } from "../remotes/docker/plan";
import { machinePlanLocal } from "../remotes/local/plan";

/**
 * The machine PLAN operation: the read-only diff of what applying the
 * stored policy *would* do — the terraform pattern's inspect half. Nothing
 * here mutates; `cadet machine apply` (the sleep → recreate → wake
 * composition) is the only thing that acts on a plan that shows drift.
 *
 * Each remote implements its own method (machinePlanDocker reads the live
 * container, machinePlanLocal narrates its process-hint semantics); the
 * router compares remotes and dispatches — a remote without a method
 * refuses the same way its sleep and wake do.
 *
 * Never throws: structured results only, like every operation.
 */

export interface AppliedMemoryState {
  /** Live cgroup `memory.max` (`--memory`); undefined = unlimited. */
  maxBytes?: number;
  /** Live cgroup `memory.high` (`--memory-reservation`); undefined = unset. */
  highBytes?: number;
  /** Live `--memory-swap`; undefined = docker's default allowance. */
  swapBytes?: number;
}

/** One field-level difference between the stored policy and the live state. */
export interface MachinePlanChange {
  field: "memory.max" | "memory.high" | "memory-swap";
  /** The live value today; undefined = unlimited / not set. */
  from: number | undefined;
  /** What the stored policy would make it; undefined = unlimited / not set. */
  to: number | undefined;
}

export type MachinePlanResult =
  | {
      ok: true;
      cloud: Remote;
      /** The stored policy — the authority this plan would apply. */
      stored: MachineMemoryPolicy | undefined;
      /** The live state the remote read; remotes without one have none. */
      applied: AppliedMemoryState | undefined;
      /** Field-level diffs between the stored policy and the live state. */
      changes: MachinePlanChange[];
      /** True when the stored policy differs from the applied state and
       * materializing it needs a restart of the remote's services. */
      requiresRecreate: boolean;
      /** Per-remote honesty: what applying means here, when it isn't a diff. */
      note?: string;
    }
  | { ok: false; status: number; error: string };

/** The remote -> plan-method table; remotes add their leg as its apply
 * path lands. A remote absent from the table refuses the plan. */
const machinePlan: Partial<
  Record<Remote, (entry: LockfileAssistant) => Promise<MachinePlanResult>>
> = {
  docker: machinePlanDocker,
  local: machinePlanLocal,
};

/**
 * The stored-vs-applied diff for an assistant's machine policy — the
 * remote-routed read-only half of the terraform pattern.
 */
export async function planMachine(
  entry: LockfileAssistant,
): Promise<MachinePlanResult> {
  const plan = machinePlan[entry.cloud];
  if (!plan) {
    return {
      ok: false,
      status: 400,
      error: `'${cliCommand()} machine plan' is unsupported for a ${entry.cloud} assistant.`,
    };
  }
  return await plan(entry);
}
