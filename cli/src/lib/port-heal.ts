import { findOpenPort } from "./port-allocator.js";
import { getDefaultPorts } from "./environments/paths.js";
import { findPidListeningOnPort } from "./remotes/local.js";
import { isCadetProcess } from "./process.js";
import { loadAllAssistants } from "./assistant-config.js";
import type { LockfileAssistant } from "./assistant-config.js";

/**
 * Wake-time port auto-heal (the other half of the port de-clash).
 *
 * A local entry's recorded ports are what wake binds — and when another
 * install (a still-running vellum assistant, a pre-de-clash migration, a
 * stray dev server) holds one, the daemon used to die on EADDRINUSE with a
 * structured startup error, or a docker-less wake "succeeded" while a
 * foreign listener answered its health probe. Instead of refusing to wake,
 * a conflicted entry MOVES: each recorded port that something else holds is
 * reallocated with hatch's own allocator rules (walk upward from the
 * environment's base ports, skipping everything claimed), the entry is
 * rewritten, and wake says so loudly.
 *
 * Ports held by our own processes are never moved — an orphaned cadet
 * daemon still answering on its recorded port is adopted by the normal
 * orphan path, not reassigned (moving it would split the brain: the old
 * daemon keeps the port while a second one starts on the new one). The
 * discriminator is the listener's pid: `lsof` finds it, `isCadetProcess`
 * proves it's ours.
 */

export interface PortHealMove {
  field: "daemonPort" | "port" | "cesPort";
  from: number;
  to: number;
}

export interface PortHealResult {
  moves: PortHealMove[];
}

export interface PortHealDeps {
  /**
   * Bind probe — a port is free when this resolves true. Defaults to
   * findOpenPort's kernel bind test on 0.0.0.0.
   */
  isPortFree?: (port: number) => Promise<boolean>;
  /** The pid listening on a port, when discoverable. Defaults to lsof. */
  findListenerPid?: (port: number) => number | undefined;
  /** Ports recorded by OTHER local entries in the lockfile. */
  otherReservedPorts?: () => number[];
  /** Whether a listener pid belongs to one of our own processes. */
  isOurProcess?: (pid: number) => boolean;
  /**
   * Allocate a fresh port walking from `base` past `exclude`. Defaults to
   * the same 100-port walk cadet's own allocator uses, probing with
   * {@link PortHealDeps.isPortFree} — one probe notion, both jobs.
   */
  allocatePort?: (base: number, exclude: number[]) => Promise<number>;
}

const HEALED_PORT_FIELDS = ["daemonPort", "port", "cesPort"] as const;

/**
 * Probe a recorded port for "something else holds it": a one-candidate
 * findOpenPort resolves only when the kernel lets us bind. Any failure
 * (EADDRINUSE, EACCES, …) reads as conflicted — a port we cannot bind is a
 * port the assistant cannot use either, so the heal moves off it.
 */
async function isPortFreeDefault(port: number): Promise<boolean> {
  try {
    await findOpenPort(port, { maxAttempts: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The walk cadet's own allocator uses (findAvailablePort's shape): linear
 * from the env base, skipping excluded ports, up to 100 — probed with the
 * same isPortFree the held-detection used, so tests that inject one probe
 * notion get both jobs hermetically.
 */
function makeAllocator(
  isPortFree: (port: number) => Promise<boolean>,
): (base: number, exclude: number[]) => Promise<number> {
  return async (base, exclude) => {
    const taken = new Set(exclude);
    for (let offset = 0; offset < 100; offset++) {
      const port = base + offset;
      if (taken.has(port)) continue;
      if (await isPortFree(port)) return port;
    }
    throw new Error(`no free port scanning from ${base} to ${base + 99}`);
  };
}

/** Ports recorded by every OTHER local entry in the lockfile. */
function otherReservedPortsDefault(assistantId: string): number[] {
  const reserved: number[] = [];
  for (const other of loadAllAssistants()) {
    if (other.assistantId === assistantId) continue;
    if (other.cloud !== "local") continue;
    if (other.daemonPort !== undefined) reserved.push(other.daemonPort);
    if (other.port !== undefined) reserved.push(other.port);
    if (other.cesPort !== undefined) reserved.push(other.cesPort);
  }
  return reserved;
}

/**
 * Reallocate every recorded port a foreign process holds, in place.
 * Returns the moves, or null when there was nothing to heal (not a local
 * entry, or every recorded port is free or ours).
 */
export async function healConflictedLocalPorts(
  entry: LockfileAssistant,
  deps: PortHealDeps = {},
): Promise<PortHealResult | null> {
  if (entry.cloud !== "local") return null;

  const isPortFree = deps.isPortFree ?? isPortFreeDefault;
  const findListenerPid = deps.findListenerPid ?? findPidListeningOnPort;
  const isOurProcess = deps.isOurProcess ?? isCadetProcess;
  const allocatePort = deps.allocatePort ?? makeAllocator(isPortFree);
  const reserved = new Set<number>(
    deps.otherReservedPorts?.() ?? otherReservedPortsDefault(entry.assistantId),
  );
  // The entry's own remaining recorded ports are claims too — the new
  // daemon port must not take the gateway's, and every field must move OFF
  // the ports being abandoned.
  for (const field of HEALED_PORT_FIELDS) {
    const recorded = entry[field];
    if (recorded !== undefined) reserved.add(recorded);
  }

  const basePorts = getDefaultPorts();
  const moves: PortHealMove[] = [];
  for (const field of HEALED_PORT_FIELDS) {
    const recorded = entry[field];
    if (recorded === undefined) continue;
    if (await isPortFree(recorded)) continue;

    const listenerPid = findListenerPid(recorded);
    if (listenerPid !== undefined && isOurProcess(listenerPid)) {
      // Our own process holds it (an orphan the normal path adopts) — the
      // recorded port is the true state, leave it alone.
      continue;
    }

    const base =
      field === "daemonPort"
        ? basePorts.daemon
        : field === "port"
          ? basePorts.gateway
          : basePorts.ces;
    const fresh = await allocatePort(base, [...reserved]);
    entry[field] = fresh;
    reserved.add(fresh);
    moves.push({ field, from: recorded, to: fresh });
  }

  // The recorded port is authoritative — the heal rewrites it in place
  // and every reader derives the gateway address from it.
  return moves.length > 0 ? { moves } : null;
}
