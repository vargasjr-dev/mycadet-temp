import { execOutput } from "../exec";
import { saveLockfileAssistant } from "../lockfile";
import {
  MACHINE_APPLICABILITY,
  MachinePolicySchema,
  type LockfileAssistant,
  type MachinePolicy,
} from "../lockfile-contract";
import { dockerResourceNames } from "../remotes/docker/retire";

/**
 * The machine OPERATIONS: the headless core of `cadet machine get|set|reset`.
 * The write verbs are pure lockfile mutations — the policy store resolves at
 * write time (the contract's strict schema validates the merged section), and
 * the "pending" narration is the operation's job so the daemon PATCH route
 * (machine-config tranche 4) renders the same semantics. The read verb adds
 * the applied state: for docker remotes the assistant container's actual
 * cgroup flags from `docker inspect`; local remotes apply policy as process
 * hints at worker spawn, so there is no live value to read.
 *
 * Like sleep/retire, operations never throw and never exit the process —
 * failures come back structured so the CLI's exit-code UX and future wire
 * mappings render the same detail.
 */

/** Docker run-flag units are binary (docker's RAMInBytes); SI forms too.
 * The store holds canonical bytes either way — the grammar just normalizes. */
const BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1e3,
  kb: 1e3,
  m: 1e6,
  mb: 1e6,
  g: 1e9,
  gb: 1e9,
  t: 1e12,
  tb: 1e12,
  ki: 1024,
  kib: 1024,
  mi: 1024 ** 2,
  mib: 1024 ** 2,
  gi: 1024 ** 3,
  gib: 1024 ** 3,
  ti: 1024 ** 4,
  tib: 1024 ** 4,
};

/**
 * Parse a human byte size into canonical bytes: bare integers are bytes,
 * `ki|mi|gi|ti` (with optional trailing `b`) are 1024-based, and the bare
 * SI forms `k|m|g|t` (+`b`) are 1000-based — the k8s/docker convention.
 * `undefined` for anything else, so the caller reports the grammar in its
 * own voice.
 */
export function parseMachineBytes(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(b|[kmgt](?:i)?b?)?$/i);
  if (!match) return undefined;
  const bytes =
    Number(match[1]) * (match[2] ? BYTE_UNITS[match[2].toLowerCase()]! : 1);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return undefined;
  return bytes;
}

/** The inverse convenience for narration: exact-fit unit, else raw bytes. */
export function formatMachineBytes(bytes: number): string {
  for (const [suffix, unit] of [
    ["TiB", 1024 ** 4],
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ] as const) {
    if (bytes % unit === 0) return `${bytes / unit}${suffix}`;
  }
  return `${bytes}B`;
}

/** Key paths `machine set` accepts; `machine reset` also takes `memory`. */
export const MACHINE_SET_PATHS = ["memory.max", "memory.high"] as const;
export const MACHINE_RESET_PATHS = ["memory", ...MACHINE_SET_PATHS] as const;

export type MachineMutationResult =
  | { ok: true; machine: MachinePolicy | undefined; note: string }
  | { ok: false; status: number; error: string };

/** The pending narration per remote: what it takes for stored policy to bite. */
function pendingNote(entry: LockfileAssistant): string {
  const applicability = MACHINE_APPLICABILITY[entry.cloud];
  if (applicability === "cgroup") {
    return "Pending — stored. Takes effect when the container is recreated (sleep, then wake).";
  }
  if (applicability === "process-hint") {
    return "Pending — stored. Takes effect at the next worker spawn.";
  }
  return "Stored — no apply path for this remote yet.";
}

/** Validate the merged section and persist it as the entry's machine patch. */
function writeMachinePolicy(
  entry: LockfileAssistant,
  machine: MachinePolicy | undefined,
): MachineMutationResult {
  if (machine === undefined) {
    try {
      saveLockfileAssistant({
        assistantId: entry.assistantId,
        machine: undefined,
      });
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: true, machine: undefined, note: pendingNote(entry) };
  }
  const parsed = MachinePolicySchema.safeParse(machine);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: `Invalid machine policy: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    };
  }
  try {
    saveLockfileAssistant({
      assistantId: entry.assistantId,
      machine: parsed.data,
    });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, machine, note: pendingNote(entry) };
}

/**
 * Set one machine key (`memory.max` / `memory.high`) to a parsed byte size
 * and store the merged, validated section. The value grammar is
 * {@link parseMachineBytes}'s; cross-field rules (high ≤ max) are the
 * schema's — this never re-derives them.
 */
export function machineSetKey(
  entry: LockfileAssistant,
  keyPath: string,
  rawValue: string,
): MachineMutationResult {
  if (!(MACHINE_SET_PATHS as readonly string[]).includes(keyPath)) {
    return {
      ok: false,
      status: 400,
      error: `Unknown machine key '${keyPath}'. Valid keys: ${MACHINE_SET_PATHS.join(", ")}.`,
    };
  }
  const bytes = parseMachineBytes(rawValue);
  if (bytes === undefined) {
    return {
      ok: false,
      status: 400,
      error: `Invalid size '${rawValue}'. Use bytes, or a suffix like 512MiB, 8GiB, 1TiB (1024-based) or 100MB, 2GB (1000-based).`,
    };
  }
  const [section, key] = keyPath.split(".") as ["memory", "max" | "high"];
  const memory = { ...entry.machine?.memory, [key]: bytes };
  return writeMachinePolicy(entry, { ...entry.machine, memory });
}

/**
 * Clear one machine key, the whole `memory` section, or the entire machine
 * section — back to the spec defaults the runtime owns.
 */
export function machineResetKey(
  entry: LockfileAssistant,
  keyPath?: string,
): MachineMutationResult {
  if (keyPath === undefined) {
    return writeMachinePolicy(entry, undefined);
  }
  if (!(MACHINE_RESET_PATHS as readonly string[]).includes(keyPath)) {
    return {
      ok: false,
      status: 400,
      error: `Unknown machine path '${keyPath}'. Valid paths: ${MACHINE_RESET_PATHS.join(", ")}.`,
    };
  }
  if (keyPath === "memory") {
    return writeMachinePolicy(entry, undefined);
  }
  const key = keyPath.split(".")[1] as "max" | "high";
  const memory = { ...entry.machine?.memory, [key]: undefined };
  const hasMemoryKeys = Object.values(memory).some((v) => v !== undefined);
  return writeMachinePolicy(
    entry,
    hasMemoryKeys ? { ...entry.machine, memory } : undefined,
  );
}

/** The applied (materialized) machine state, read from the live remote. */
export interface MachineAppliedState {
  /** cgroup memory.max the container was created with; undefined = unlimited. */
  memoryMax?: number;
  /** cgroup memory.high the container was created with; undefined = unlimited. */
  memoryHigh?: number;
}

export type MachineGetResult =
  | {
      ok: true;
      /** The stored policy, exactly as validated — unset means spec defaults. */
      stored: MachinePolicy | undefined;
      /** The live materialized state; absent when it cannot be read. */
      applied?: MachineAppliedState;
      /** Why applied is absent, when it is. */
      note?: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Read the stored policy and, where the remote materializes one, the applied
 * state — for docker remotes the assistant container's actual cgroup flags
 * (`docker inspect` HostConfig), so `machine get` shows real drift when the
 * flags were hand-tampered. Local remotes apply policy as process hints at
 * worker spawn; there is no live value to read, so `note` says when they
 * take effect instead.
 */
export async function machineGet(
  entry: LockfileAssistant,
): Promise<MachineGetResult> {
  const stored = entry.machine;
  if (entry.cloud === "docker") {
    const container = dockerResourceNames(entry.assistantId).assistantContainer;
    try {
      const out = await execOutput("docker", [
        "inspect",
        "--format",
        "{{.HostConfig.Memory}} {{.HostConfig.MemoryReservation}}",
        container,
      ]);
      const [max, high] = out.trim().split(/\s+/).map(Number);
      const applied: MachineAppliedState = {
        memoryMax: max !== undefined && max > 0 ? max : undefined,
        memoryHigh: high !== undefined && high > 0 ? high : undefined,
      };
      return { ok: true, stored, applied };
    } catch {
      return {
        ok: true,
        stored,
        note: "Assistant container not found — nothing applied (wake recreates it).",
      };
    }
  }
  if (entry.cloud === "local") {
    return {
      ok: true,
      stored,
      note: "Local assistants take these as process hints at worker spawn — no live value to read.",
    };
  }
  return {
    ok: true,
    stored,
    note: `Machine policy is not applied for ${entry.cloud} assistants yet.`,
  };
}
