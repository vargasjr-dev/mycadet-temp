import { saveLockfileAssistant } from "../lockfile";
import {
  MACHINE_APPLICABILITY,
  MachinePolicySchema,
  type LockfileAssistant,
  type MachinePolicy,
} from "../lockfile-contract";

/**
 * The machine OPERATIONS: the headless core of `cadet machine get|set|reset`.
 * The write verbs are pure lockfile mutations — the policy store resolves at
 * write time (the contract's strict schema validates the merged section), and
 * the "pending" narration is the operation's job so the daemon PATCH route
 * (machine-config tranche 4) renders the same semantics.
 *
 * `machineGet` is deliberately simple: it returns the stored policy fields
 * and nothing else. Remote discrimination, live-state reads, and the
 * stored-vs-applied comparison belong to `machine plan` (tranche 3), not to
 * the read verb.
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
 * The value grammar `machine set` accepts: bare integers are bytes,
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

/** Key paths `machine set` accepts; `machine reset` also takes `memory`. */
export const MACHINE_SET_PATHS = ["memory.max", "memory.high"] as const;
export const MACHINE_RESET_PATHS = ["memory", ...MACHINE_SET_PATHS] as const;

export type MachineMutationResult =
  | {
      ok: true;
      machine: MachinePolicy | undefined;
      /** The byte size written by a `set` (absent for a reset). */
      value?: number;
      note: string;
    }
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

function persist(
  entry: LockfileAssistant,
  machine: MachinePolicy | undefined,
): { ok: true } | { ok: false; status: number; error: string } {
  try {
    saveLockfileAssistant({ assistantId: entry.assistantId, machine });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Validate the merged section and persist it as the entry's machine patch. */
function writeMachinePolicy(
  entry: LockfileAssistant,
  machine: MachinePolicy | undefined,
): MachineMutationResult {
  // An all-optional section parses `{}` happily — clearing the section must
  // bypass the schema and write the field away instead.
  if (machine === undefined) {
    const written = persist(entry, undefined);
    if (!written.ok) return written;
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
  const written = persist(entry, parsed.data);
  if (!written.ok) return written;
  return { ok: true, machine, note: pendingNote(entry) };
}

/**
 * Set one machine key (`memory.max` / `memory.high`) to a parsed byte size
 * and store the merged, validated section. The value grammar is
 * {@link parseMachineBytes}'; cross-field rules (high ≤ max) are the
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
  const [, key] = keyPath.split(".") as ["memory", "max" | "high"];
  const memory = { ...entry.machine?.memory, [key]: bytes };
  const result = writeMachinePolicy(entry, { ...entry.machine, memory });
  if (result.ok) return { ...result, value: bytes };
  return result;
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

export type MachineGetResult =
  | { ok: true; machine: MachinePolicy | undefined }
  | { ok: false; status: number; error: string };

/**
 * The stored machine policy for an entry — the policy fields, nothing else.
 * What a policy MEANS per remote and how stored compares to applied is
 * `machine plan`'s job (tranche 3).
 */
export function machineGet(entry: LockfileAssistant): MachineGetResult {
  return { ok: true, machine: entry.machine };
}
