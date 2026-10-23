/**
 * Sync cloud-managed (platform) assistants into the local lockfile.
 *
 * - Adds new platform assistants that aren't in the lockfile yet.
 * - Removes lockfile entries whose IDs are no longer returned by the cloud
 *   (e.g. retired assistants).
 *
 * Used by both `cadet login` and `cadet ps` to keep the lockfile fresh.
 *
 * **Contract:** callers must verify the user is logged in (i.e. a non-empty
 * platform token exists) before invoking this helper. The "is there a token?"
 * decision belongs at the command level so commands can render the right
 * "Platform: …" status without ever entering the cloud fetch path.
 */

import { isCloudHome } from "./cloud-values.js";
import {
  loadAllAssistants,
  removeLockfileAssistant,
  saveLockfileAssistant,
} from "./assistant-config.js";
import {
  fetchCurrentUser,
  fetchCloudAssistants,
  getCloudUrl,
} from "./cloud-client.js";

export type SyncLogger = (message: string) => void;

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.includes("timed out"))
  );
}

export interface SyncResult {
  added: number;
  removed: number;
  email?: string;
}

export interface SyncOptions {
  log?: SyncLogger;
}

/**
 * Fetch platform assistants and reconcile against the lockfile.
 *
 * Returns the number of entries added/removed, or `null` if the fetch fails
 * (e.g. platform unreachable, invalid token). Callers must pre-verify a
 * non-empty token; this function assumes one is present and will throw if
 * called with an empty string.
 */
export async function syncCloudAssistants(
  token: string,
  options?: SyncOptions,
): Promise<SyncResult | null> {
  if (!token) {
    throw new Error(
      "syncCloudAssistants called without a token. Callers must check `readCloudToken()` first.",
    );
  }
  const log = options?.log;
  const cloudUrl = getCloudUrl();
  log?.(`Platform URL: ${cloudUrl}`);
  log?.(`Token found (${token.length} chars, prefix: ${token.slice(0, 6)}…)`);

  // Fetch user info for the login status line
  let email: string | undefined;
  try {
    log?.("Fetching current user…");
    const user = await fetchCurrentUser(token);
    email = user.email;
    log?.(`Authenticated as ${user.email} (${user.id})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`Failed to fetch current user: ${msg}`);
    if (isTimeoutError(err)) {
      console.warn(
        "Warning: Cadet Cloud user lookup timed out — skipping cloud sync",
      );
    }
  }

  let cloudAssistants: { id: string; name: string; status: string }[];
  try {
    log?.("Fetching Cadet Cloud assistants…");
    cloudAssistants = await fetchCloudAssistants(token);
    log?.(
      `Cadet Cloud returned ${cloudAssistants.length} ${cloudAssistants.length === 1 ? "assistant" : "assistants"}: ${cloudAssistants.map((a) => a.name || a.id).join(", ") || "(none)"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`Cadet Cloud assistant lookup failed: ${msg}`);
    if (isTimeoutError(err)) {
      console.warn(
        "Warning: Cadet Cloud assistant fetch timed out — using cached data",
      );
    }
    return null;
  }

  if (cloudAssistants.length === 0) {
    log?.(
      "Cadet Cloud returned 0 assistants — this may mean the API returned a non-ok status (check token validity)",
    );
  }

  const platformIds = new Set(cloudAssistants.map((a) => a.id));

  // Add new platform assistants not yet in the lockfile
  const existingCloudEntries = loadAllAssistants().filter((a) =>
    isCloudHome(a.cloud),
  );
  const existingCloudById = new Map(
    existingCloudEntries.map((a) => [a.assistantId, a]),
  );
  const existingCloudIds = new Set(existingCloudById.keys());
  log?.(
    `Lockfile has ${existingCloudIds.size} ${existingCloudIds.size === 1 ? "cloud assistant" : "cloud assistants"}: ${[...existingCloudIds].join(", ") || "(none)"}`,
  );

  let added = 0;
  let updated = 0;
  for (const pa of cloudAssistants) {
    const existing = existingCloudById.get(pa.id);
    const assistantName = pa.name.trim();
    const nameFields = assistantName ? { name: assistantName } : {};
    if (!existing) {
      log?.(`Adding ${pa.name || pa.id} to lockfile`);
      saveLockfileAssistant({
        assistantId: pa.id,
        ...nameFields,
        runtimeUrl: getCloudUrl(),
        cloud: "cloud",
        hatchedAt: new Date().toISOString(),
      });
      added++;
    } else if (assistantName && existing.name !== assistantName) {
      log?.(`Updating ${pa.id} name to ${assistantName}`);
      saveLockfileAssistant({
        ...existing,
        name: assistantName,
      });
      updated++;
    }
  }

  // Remove stale lockfile entries that the cloud no longer knows about
  let removed = 0;
  for (const id of existingCloudIds) {
    if (!platformIds.has(id)) {
      log?.(`Removing stale entry ${id} from lockfile`);
      removeLockfileAssistant(id);
      removed++;
    }
  }

  log?.(
    `Sync complete: ${added} added, ${updated} updated, ${removed} removed`,
  );
  return { added, removed, email };
}
