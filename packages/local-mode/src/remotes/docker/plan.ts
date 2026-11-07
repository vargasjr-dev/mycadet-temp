import type {
  LockfileAssistant,
  MachineMemoryPolicy,
} from "../../lockfile-contract";
import { cliCommand } from "../../environment";
import { execOutput } from "../../exec";
import { dockerResourceNames } from "./retire";
import type {
  AppliedMemoryState,
  MachinePlanChange,
  MachinePlanResult,
} from "../../operations/machine-plan";

/**
 * The docker topology's plan leg: read the assistant container's live memory
 * HostConfig and diff it against the stored policy — the applied-state reader
 * plus the comparison, so `cadet machine plan` shows exactly what a recreate
 * would change. Nothing here mutates; `machine apply` acts on the plan.
 *
 * Never throws: a container that was never created (or was removed by a
 * sleep) has no live state to diff — the answer says the policy applies on
 * the next recreate instead of inventing a diff against nothing.
 */

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
  const match = raw.trim().match(/Memory=(\d+) Reservation=(\d+) Swap=(\d+)/);
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
  if (stored?.max !== applied.maxBytes) {
    changes.push({
      field: "memory.max",
      from: applied.maxBytes,
      to: stored?.max,
    });
  }
  if (stored?.high !== applied.highBytes) {
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

export async function machinePlanDocker(
  entry: LockfileAssistant,
): Promise<MachinePlanResult> {
  const stored = entry.machine?.memory;
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
