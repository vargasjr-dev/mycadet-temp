import type {
  LockfileAssistant,
  MachineMemoryPolicy,
  Remote,
} from "../lockfile-contract";
import { cliCommand } from "../environment";
import { execOutput } from "../exec";
import { dockerResourceNames } from "../remotes/docker/retire";
import { machineMemoryRunArgs } from "../remotes/docker/memory";
import { MACHINE_APPLICABILITY } from "../lockfile-contract";

/**
 * The machine PLAN operation: the read-only diff of what applying the
 * stored policy *would* do — the terraform pattern's inspect half. Nothing
 * here mutates; `cadet machine apply` (the CLI's sleep → recreate → wake
 * composition) is the only thing that acts on a plan that shows drift.
 *
 * This is also where the applied-state reader lives (a review ruling from
 * #666): the docker leg reads the assistant container's live HostConfig
 * memory values via `docker inspect` and compares them against the flags
 * the stored policy would produce. Remotes without an apply path answer
 * honestly about what their policy means instead of pretending to diff.
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
      /** The live state the docker leg read; other remotes have none. */
      applied: AppliedMemoryState | undefined;
      /** Field-level diffs between the stored policy and the live state. */
      changes: MachinePlanChange[];
      /** True when the stored policy differs from the applied state and
       * materializing it needs a container recreate (a docker restart). */
      requiresRecreate: boolean;
      /** Per-remote honesty: what applying means here, when it isn't a diff. */
      note?: string;
    }
  | { ok: false; status: number; error: string };

/** Read the assistant container's live memory HostConfig; undefined when
 * the container doesn't exist (never created, or removed by a sleep). */
async function inspectAppliedMemory(
  containerName: string,
): Promise<AppliedMemoryState | undefined> {
  let raw: string;
  try {
    raw = await execOutput("docker", [
      "inspect",
      containerName,
      "--format",
      "Memory={{.HostConfig.Memory}} Reservation={{.HostConfig.MemoryReservation}} Swap={{.HostConfig.MemorySwap}}",
    ]);
  } catch {
    return undefined;
  }
  const match = raw
    .trim()
    .match(/Memory=(\d+) Reservation=(\d+) Swap=(\d+)/);
  if (!match) return undefined;
  const read = (field: string): number | undefined => {
    const bytes = Number(field);
    return bytes > 0 ? bytes : undefined;
  };
  return {
    maxBytes: read(match[1]!),
    highBytes: read(match[2]!),
    swapBytes: read(match[3]!),
  };
}

/**
 * Compare the stored policy against the live state, as flag-level fields —
 * the same fields {@link machineMemoryRunArgs} would emit on the next
 * recreate. No policy and no live limits = no diff.
 */
function memoryChanges(
  stored: MachineMemoryPolicy | undefined,
  applied: AppliedMemoryState,
): MachinePlanChange[] {
  const changes: MachinePlanChange[] = [];
  const differs = (
    stored: number | undefined,
    applied: number | undefined,
  ): boolean => stored !== applied;
  if (differs(stored?.max, applied.maxBytes)) {
    changes.push({
      field: "memory.max",
      from: applied.maxBytes,
      to: stored?.max,
    });
  }
  if (differs(stored?.high, applied.highBytes)) {
    changes.push({
      field: "memory.high",
      from: applied.highBytes,
      to: stored?.high,
    });
  }
  // The swap pin rides max: a policy that pins max wants swap == max (no
  // 2× docker default); anything else is drift even when max itself matches.
  if (
    stored?.max !== undefined &&
    applied.maxBytes === stored.max &&
    applied.swapBytes !== applied.maxBytes
  ) {
    changes.push({
      field: "memory-swap",
      from: applied.swapBytes,
      to: stored.max,
    });
  }
  return changes;
}

/**
 * The stored-vs-applied diff for an assistant's machine policy. Docker
 * reads the live container; `local` has no live value (its policy is a
 * process hint that takes effect at the next worker spawn — nothing to
 * restart, so never "requires recreate"); remotes without an apply path
 * say so.
 */
export async function planMachine(
  entry: LockfileAssistant,
): Promise<MachinePlanResult> {
  const stored = entry.machine?.memory;
  const applicability = MACHINE_APPLICABILITY[entry.cloud];

  if (entry.cloud === "docker") {
    const res = dockerResourceNames(entry.assistantId);
    const applied = await inspectAppliedMemory(res.assistantContainer);
    if (applied === undefined) {
      return {
        ok: true,
        cloud: entry.cloud,
        stored,
        applied: undefined,
        changes: [],
        requiresRecreate: false,
        note: stored
          ? `the assistant container isn't running — the stored policy applies on the next recreate (\`${cliCommand()} machine apply\`)`
          : "the assistant container isn't running, and no policy is stored",
      };
    }
    const changes = memoryChanges(stored, applied);
    return {
      ok: true,
      cloud: entry.cloud,
      stored,
      applied,
      changes,
      requiresRecreate: changes.length > 0,
      note:
        changes.length > 0
          ? `apply with \`${cliCommand()} machine apply\` — the containers are recreated (sleep, then wake)`
          : undefined,
    };
  }

  if (applicability === "process-hint") {
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

  return {
    ok: true,
    cloud: entry.cloud,
    stored,
    applied: undefined,
    changes: [],
    requiresRecreate: false,
    note: "no apply path for this remote yet",
  };
}
