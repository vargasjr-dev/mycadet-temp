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

export type AssistantLookupResult =
  | { status: "found"; entry: LockfileAssistant }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: LockfileAssistant[] };

export function loadAllAssistants(): LockfileAssistant[] {
  return readLockfile().assistants;
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
    return { status: "found", entry: displayMatches[0]! };
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
