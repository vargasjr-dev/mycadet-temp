import { readLockfile, writeRawLockfile } from "../lockfile";
import { withLockfileLock } from "../lockfile-lock";
import { getGatewayUrl } from "../lockfile-contract";
import type { Lockfile, LockfileAssistant } from "../lockfile-contract";

/**
 * The assistant bookkeeping the operations share: name-or-id resolution,
 * display naming, and the lockfile entry removal with the active-assistant
 * reassignment. Moved out of the CLI's `assistant-config.ts` so an operation
 * resolves its own target — the hosts call these directly, no CLI in the
 * loop. The CLI's module re-exports them for its remaining consumers.
 */

export function loadAllAssistants(): LockfileAssistant[] {
  return readLockfile().assistants;
}

export function findAssistant(id?: string | null): LockfileAssistant | null {
  const lockfile = readLockfile();
  if (!id) {
    // The bare spelling rides the operator backend's active assistant —
    // its first entry when no active pointer is set. The hatch leg
    // switches active to the freshly minted entry inside its locked
    // write, so this resolution names the entry a hatch just created too.
    return (
      lockfile.assistants.find(
        (entry) => entry.assistantId === lockfile.activeAssistant,
      ) ??
      lockfile.assistants[0] ??
      null
    );
  }
  return lockfile.assistants.find((entry) => entry.assistantId === id) ?? null;
}

/**
 * Why a hatch can't take `name`: assistant ids key the lockfile, the token
 * files, and the docker resources, so no two assistants may share one.
 */
export function hatchNameConflict(name: string): string | null {
  if (!findAssistant(name)) return null;
  return (
    `An assistant named "${name}" is already hatched.\n` +
    `Run \`cadet wake\` to restart it, or \`cadet retire ${name}\` to remove it first.`
  );
}

export function getAssistantDisplayName(entry: LockfileAssistant): string {
  return entry.name?.trim() || entry.assistantId;
}

function writeLockfileUnlocked(data: Lockfile): void {
  const result = writeRawLockfile(data);
  if (!result.ok) {
    throw new Error(result.error);
  }
}

export function removeLockfileAssistant(assistantId: string): void {
  const locked = withLockfileLock(() => {
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
  if (!locked.ok) {
    throw new Error(locked.error);
  }
}

export function getActiveAssistant(): string | null {
  const data = readLockfile();
  return data.activeAssistant ?? null;
}

/** Release the edge's process entry — the record and its riding build stamp go with it. */
export function clearAppProcessRecord(expectedPid?: number): void {
  const locked = withLockfileLock(() => {
    const data = readLockfile();
    const record = data.app;
    if (
      record === undefined ||
      (expectedPid !== undefined && record.pid !== expectedPid)
    )
      return;
    delete data.app;
    writeLockfileUnlocked(data);
  });
  if (!locked.ok) {
    throw new Error(locked.error);
  }
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
    return gatewayUrl.replace(/^https?:\/\//, "").split(":")[0]!;
  }
}
