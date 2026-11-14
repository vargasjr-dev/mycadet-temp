import type { LockfileAssistant } from "../../lockfile-contract";
import { findAssistantByName } from "../../operations/lookup";
import { allocateLocalPlacement } from "../../remotes/local/hatch";
import { withLocalHatchLock } from "../../remotes/local/hatch-lock";
import { initializeRootArchive } from "../../root-backup";
import { saveLockfileAssistant } from "../../lockfile";

/**
 * Initialize a fresh teleport target's local placement: allocate the
 * instance dir and ports under the hatch lock, install the transferred
 * archive (gateway-security included, so the gateway boots with the archived
 * signing identity), and persist the entry. The wake is the caller's — a
 * hatch is just initialize-data + wake, and the teleport owns both halves
 * itself.
 */
export async function initializeLocalTeleportTarget(
  instanceName: string,
  archive: string,
): Promise<LockfileAssistant> {
  await withLocalHatchLock(async () => {
    const entry: LockfileAssistant = {
      assistantId: instanceName,
      cloud: "local",
      ...(await allocateLocalPlacement(instanceName)),
    };
    await initializeRootArchive(entry, archive);
    entry.hatchedAt = new Date().toISOString();
    saveLockfileAssistant(entry, instanceName);
  });
  const entry = findAssistantByName(instanceName);
  if (!entry) {
    throw new Error("Could not find the newly initialized teleport target.");
  }
  return entry;
}
