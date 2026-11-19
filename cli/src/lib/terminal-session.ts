/**
 * The managed-assistant resolver for the CLI's terminal commands: resolve
 * an assistant from the lockfile or exit with the reason. The session
 * transports themselves live with the other remote legs in
 * @mycadet/local-mode (remotes/cloud/exec.ts).
 */

import { readCloudToken } from "@mycadet/local-mode";
import { getCloudBaseUrl } from "@mycadet/shared";
import type { ResolvedManagedAssistant } from "@mycadet/local-mode";
import { findAssistant } from "@mycadet/local-mode";

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a managed assistant from the lockfile. Exits with an error if
 * the assistant is not found or the user isn't logged in.
 */
export function resolveManagedAssistant(
  nameArg?: string,
): ResolvedManagedAssistant {
  const entry = findAssistant(nameArg);

  if (!entry) {
    if (nameArg) {
      console.error(`No assistant instance found with name '${nameArg}'.`);
    } else {
      console.error("No assistant instance found. Run `cadet hatch` first.");
    }
    process.exit(1);
  }

  const token = readCloudToken();
  if (!token) {
    console.error(
      "Not logged in. Run `cadet login` first to authenticate with Cadet Cloud.",
    );
    process.exit(1);
  }

  return {
    assistantId: entry.assistantId,
    token,
    cloudUrl: getCloudBaseUrl(),
  };
}
