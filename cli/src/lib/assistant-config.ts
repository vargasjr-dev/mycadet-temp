import { randomBytes } from "crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import {
  readLockfile,
  saveLockfileAssistant,
  withLockfileLock,
} from "@mycadet/local-mode";
import {
  type AppProcessRecord,
  type LocalAssistantResources,
  type Lockfile,
  type LockfileAssistant,
  type TunnelProcessRecord,
  getGatewayUrl,
} from "@mycadet/local-mode/contract";

export type { AppProcessRecord, LockfileAssistant, TunnelProcessRecord };

import {
  resolveAssistantsDir,
  resolveDataDir,
  resolveLockfilePath,
} from "@mycadet/local-mode";
import { getDefaultPorts } from "./environments/paths.js";
import { probePort } from "./port-probe.js";

/**
 * Per-instance resource paths and ports. Each local assistant instance gets
 * its own directory tree, ports, and socket so multiple instances can run
 * side-by-side without conflicts. The contract models every field, optional
 * fields are optional everywhere, and code that needs one guards once and
 * falls back (see {@link getLocalInstanceDir} / {@link getDaemonPidPath}).
 */

export type AssistantLookupResult =
  | { status: "found"; entry: LockfileAssistant }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: LockfileAssistant[] };

/** Either lockfile-root process record, keyed by `RootProcessKind`. */
export type RootProcessRecord = TunnelProcessRecord | AppProcessRecord;

/** The lockfile-root process entries keyed by their kind. */
export interface RootProcessRecords {
  tunnel?: TunnelProcessRecord;
  app?: AppProcessRecord;
}

export type RootProcessKind = keyof RootProcessRecords;

/**
 * Derive the daemon PID file path from a resources object. The PID file
 * lives inside the instance's workspace directory. Falls back to the XDG
 * data root's workspace when the entry carries no instance dir
 * (`$XDG_DATA_HOME/cadet[-<env>]/workspace/cadet.pid`).
 */
/**
 * The instance's data root: the recorded instanceDir, or the shared state
 * root for legacy entries predating per-instance dirs.
 */
export function getLocalInstanceDir(
  resources?: LocalAssistantResources,
): string {
  return resources?.instanceDir ?? resolveDataDir();
}

export function getDaemonPidPath(resources?: LocalAssistantResources): string {
  return join(getLocalInstanceDir(resources), "workspace", "cadet.pid");
}

function writeLockfileUnlocked(data: Lockfile): void {
  const lockfilePath = resolveLockfilePath();
  mkdirSync(dirname(lockfilePath), { recursive: true });
  const tmpPath = `${lockfilePath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmpPath, lockfilePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

/**
 * Run `fn` under the same cross-process advisory lock the local-mode hosts
 * use, keyed to this environment's write-path lockfile, so CLI writers and
 * package-side writers (Electron main, Vite plugin, `cadet client`) never
 * interleave read-modify-write cycles. Reentrant, so wrapped units may call
 * the locked write helpers. Throws on lock timeout, matching the fs-error
 * contract of the write path.
 */
function withCliLockfileLock<T>(fn: () => T): T {
  const locked = withLockfileLock(resolveLockfilePath(), fn);
  if (!locked.ok) throw new Error(locked.error);
  return locked.value;
}

/** Record a CLI-managed root process (tunnel agent, app edge) by pid. */
export function stampRootProcess<K extends RootProcessKind>(
  kind: K,
  record: RootProcessRecords[K],
): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    (data as RootProcessRecords)[kind] = record;
    writeLockfileUnlocked(data);
  });
}

/** Release a recorded process record, pid-verified. */
export function clearRootProcess(
  kind: RootProcessKind,
  expectedPid?: number,
): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    const record = (data as RootProcessRecords)[kind];
    if (
      record === undefined ||
      (expectedPid !== undefined && record.pid !== expectedPid)
    )
      return;
    delete data[kind];
    writeLockfileUnlocked(data);
  });
}

/**
 * Read the root-level process entries for `cadet ps`. Read-only: no lock, so
 * a concurrently-updating lockfile is fine — the pid is verified separately.
 */
export function readRootProcesses(): RootProcessRecords {
  const data = readLockfile();
  return { tunnel: data.tunnel, app: data.app };
}

/**
 * The edge's recorded built-sha stamp (the auto-build staleness marker the
 * resolver compares against the checkout's HEAD), or undefined when none is
 * recorded yet.
 */
export function readAppBuiltSha(): string | undefined {
  return readRootProcesses().app?.builtSha;
}

/**
 * Record the built-sha stamp on the `app` entry, creating a stamp-only entry
 * when the edge has not stamped its process yet (the stamp is written as
 * soon as a build lands, before the edge process exists).
 */
export function stampAppBuiltSha(builtSha: string): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    if (data.app) {
      data.app.builtSha = builtSha;
    } else {
      data.app = { builtSha };
    }
    writeLockfileUnlocked(data);
  });
}

/**
 * Release the edge's process entry. The built-sha stamp is a build-cache
 * fact rather than a process fact, so it is kept while the pid bookkeeping
 * goes — restarting the edge re-stamps the process fields without paying a
 * needless bundle rebuild.
 */
export function clearAppProcessRecord(expectedPid?: number): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    const record = data.app;
    if (
      record === undefined ||
      (expectedPid !== undefined && record.pid !== expectedPid)
    )
      return;
    if (record.builtSha !== undefined) {
      data.app = { builtSha: record.builtSha };
    } else {
      delete data.app;
    }
    writeLockfileUnlocked(data);
  });
}

/**
 * Try to extract a port number from a URL string (e.g. `http://localhost:7830`).
 * Returns undefined if the URL is malformed or has no explicit port.
 */

export function loadAllAssistants(): LockfileAssistant[] {
  return readLockfile().assistants;
}

export function loadLatestAssistant(): LockfileAssistant | null {
  const entries = loadAllAssistants();
  if (entries.length === 0) {
    return null;
  }
  const sorted = [...entries].sort((a, b) => {
    const ta = a.hatchedAt ? new Date(a.hatchedAt).getTime() : 0;
    const tb = b.hatchedAt ? new Date(b.hatchedAt).getTime() : 0;
    return tb - ta;
  });
  return sorted[0];
}

export function findAssistantByName(name: string): LockfileAssistant | null {
  return (
    loadAllAssistants().find((entry) => entry.assistantId === name) ?? null
  );
}

export function getAssistantDisplayName(entry: LockfileAssistant): string {
  return entry.name?.trim() || entry.assistantId;
}

function getAssistantDisplayNameCandidates(entry: LockfileAssistant): string[] {
  const name = entry.name?.trim();
  return name ? [name] : [];
}

export function lookupAssistantByIdentifier(
  identifier: string,
): AssistantLookupResult {
  const entries = loadAllAssistants();
  const exactId = entries.find((entry) => entry.assistantId === identifier);
  if (exactId) {
    return { status: "found", entry: exactId };
  }

  const displayMatches = entries.filter((entry) =>
    getAssistantDisplayNameCandidates(entry).includes(identifier),
  );
  if (displayMatches.length === 1) {
    return { status: "found", entry: displayMatches[0] };
  }
  if (displayMatches.length > 1) {
    return { status: "ambiguous", matches: displayMatches };
  }

  return { status: "not_found" };
}

export function formatAssistantLookupError(
  identifier: string,
  result: AssistantLookupResult = lookupAssistantByIdentifier(identifier),
): string {
  if (result.status === "ambiguous") {
    const matches = result.matches
      .map(
        (entry) => `${getAssistantDisplayName(entry)} (${entry.assistantId})`,
      )
      .join(", ");
    return `Multiple assistants match '${identifier}': ${matches}. Use the assistant ID to disambiguate.`;
  }

  return `No assistant found with name or ID '${identifier}'.`;
}

export function removeLockfileAssistant(assistantId: string): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    const entries = data.assistants.filter(
      (e) => e.assistantId !== assistantId,
    );
    data.assistants = entries;
    // Reassign active assistant if it matches the removed entry
    if (data.activeAssistant === assistantId) {
      const remaining = entries[0];
      if (remaining) {
        data.activeAssistant = String(remaining.assistantId);
      } else {
        data.activeAssistant = null;
      }
    }
    writeLockfileUnlocked(data);
  });
}

export function getActiveAssistant(): string | null {
  const data = readLockfile();
  return data.activeAssistant ?? null;
}

export function setActiveAssistant(assistantId: string): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    data.activeAssistant = assistantId;
    writeLockfileUnlocked(data);
  });
}

/**
 * Best-effort resolution of the target assistant. Returns null when no
 * match is found — callers decide how to handle the absence.
 *
 * Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `cadet use`
 * 3. Sole lockfile entry (any cloud)
 */
export function resolveAssistant(nameArg?: string): LockfileAssistant | null {
  if (nameArg) {
    return findAssistantByName(nameArg);
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
    // Active assistant no longer exists in lockfile — fall through
  }

  const all = loadAllAssistants();
  if (all.length === 1) return all[0];

  return null;
}

/**
 * Resolve which assistant to target for a command, exiting the process
 * with a user-facing error when resolution fails.
 *
 * Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `cadet use`
 * 3. Sole lockfile entry (any cloud)
 */
export function resolveTargetAssistant(nameArg?: string): LockfileAssistant {
  if (nameArg) {
    const result = lookupAssistantByIdentifier(nameArg);
    if (result.status === "found") return result.entry;
    console.error(formatAssistantLookupError(nameArg, result));
  } else {
    const active = getActiveAssistant();
    if (active) {
      const result = lookupAssistantByIdentifier(active);
      if (result.status === "found") return result.entry;
      if (result.status === "ambiguous") {
        console.error(formatAssistantLookupError(active, result));
        process.exit(1);
      }
      // Active assistant no longer exists in lockfile — fall through.
    }

    const all = loadAllAssistants();
    if (all.length === 1) return all[0];

    if (all.length === 0) {
      console.error(
        `No assistant found. Run 'cadet hatch' first.`,
      );
    } else {
      console.error(
        `Multiple assistants found. Set an active assistant with 'cadet use <name>'.`,
      );
    }
  }
  process.exit(1);
}

/**
 * Extract the remote host for an entry: the hostname of the gateway
 * address the entry derives. One seam so the runtimeUrl death (a later
 * PR) rewires a single site instead of every ssh flow.
 */
export function extractHostFromEntry(entry: LockfileAssistant): string {
  const gatewayUrl = getGatewayUrl(entry);
  try {
    return new URL(gatewayUrl).hostname;
  } catch {
    return gatewayUrl.replace(/^https?:\/\//, "").split(":")[0];
  }
}

/**
 * The client-minted uuid this CLI addresses the assistant's chat
 * conversation by (web's temp-client-id pattern: clients/web
 * document-conversation mints a uuid, persists it, and passes it as the
 * conversation key so creation is retry-safe). Minted once and persisted
 * on the entry so every session shares one conversation.
 */
export function resolveConversationKey(entry: LockfileAssistant): string {
  if (entry.conversationKey) return entry.conversationKey;
  const minted = crypto.randomUUID();
  saveLockfileAssistant({ ...entry, conversationKey: minted });
  return minted;
}

/**
 * Scan upward from `basePort` to find an available port. A port is considered
 * available when `probePort()` returns false (nothing listening). Scans up to
 * 100 ports above the base before giving up.
 */
async function findAvailablePort(
  basePort: number,
  excludedPorts: number[] = [],
): Promise<number> {
  const maxOffset = 100;
  for (let offset = 0; offset < maxOffset; offset++) {
    const port = basePort + offset;
    if (excludedPorts.includes(port)) continue;
    const inUse = await probePort(port);
    if (!inUse) return port;
  }
  throw new Error(
    `Could not find an available port scanning from ${basePort} to ${basePort + maxOffset - 1}`,
  );
}

/**
 * Allocate an isolated set of resources for a named local instance.
 * Every new local assistant is allocated under
 * `$XDG_DATA_HOME/cadet{-env}/assistants/<name>/`. The legacy `~/.cadet/`
 * path is only reached via existing lockfile entries from before this change
 * — the read path honors whatever `resources.instanceDir` is stored, so
 * production users' existing first-local assistants keep their `~/.cadet/`
 * roots unchanged.
 */
export async function allocateLocalResources(
  instanceName: string,
): Promise<LocalAssistantResources> {
  const instanceDir = join(resolveAssistantsDir(), instanceName);
  mkdirSync(instanceDir, { recursive: true });

  // Collect ports already assigned to other local instances in the lockfile.
  const reservedPorts: number[] = [];
  for (const entry of loadAllAssistants()) {
    if (entry.cloud !== "local" || !entry.resources) continue;
    reservedPorts.push(entry.resources.daemonPort, entry.resources.gatewayPort);
    if (entry.resources.cesPort !== undefined) {
      reservedPorts.push(entry.resources.cesPort);
    }
  }

  // Env-aware bases: non-prod envs sit in their own 1000-port window so
  // running prod and staging assistants side-by-side doesn't collide. See
  // the `@mycadet/environments` `portBlock` layout.
  const basePorts = getDefaultPorts();
  const daemonPort = await findAvailablePort(basePorts.daemon, reservedPorts);
  const gatewayPort = await findAvailablePort(basePorts.gateway, [
    ...reservedPorts,
    daemonPort,
  ]);
  const cesPort = await findAvailablePort(basePorts.ces, [
    ...reservedPorts,
    daemonPort,
    gatewayPort,
  ]);

  return {
    instanceDir,
    daemonPort,
    gatewayPort,
    cesPort,
  };
}

/**
 * Return `cloudBaseUrl` from the lockfile, if set. This is the value
 * persisted by {@link syncConfigToLockfile} the last time the active
 * assistant was hatched/waked, and is the source of truth for "which
 * platform does the currently-active assistant target".
 */
export function getLockfilePlatformBaseUrl(): string | undefined {
  const lockfile = readLockfile();
  const url = lockfile.cloudBaseUrl;
  if (typeof url === "string" && url.trim()) return url.trim();
  return undefined;
}
