/**
 * The managed-assistant resolver for the CLI's terminal commands: resolve a
 * cloud-hosted assistant from the lockfile or exit with the reason. The
 * session transports themselves live with the other remote legs in
 * @mycadet/local-mode (remotes/cloud/exec.ts).
 */

import { getCloudUrl, readCloudToken } from "@mycadet/local-mode";
import { isCloudEntry } from "@mycadet/local-mode/contract";
import type { ResolvedManagedAssistant } from "@mycadet/local-mode";
import { resolveAssistant } from "./assistant-config.js";

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a cloud (cloud-hosted) assistant from the lockfile. Exits with
 * an error if the assistant is not found, not managed, or the user isn't
 * logged in.
 */
export function resolveManagedAssistant(
  nameArg?: string,
): ResolvedManagedAssistant {
  const entry = resolveAssistant(nameArg);

  if (!entry) {
    if (nameArg) {
      console.error(`No assistant instance found with name '${nameArg}'.`);
    } else {
      console.error("No assistant instance found. Run `cadet hatch` first.");
    }
    process.exit(1);
  }

  const cloud = entry.cloud;
  if (!isCloudEntry(entry)) {
    if (cloud === "local") {
      console.error(
        "This assistant runs locally on your machine. You can access it directly.",
      );
    } else if (cloud === "docker") {
      console.error(
        `Use 'cadet exec -it -- /bin/bash' or 'cadet terminal' for ${cloud} instances.`,
      );
    } else {
      console.error(
        `'cadet terminal' is for managed (cloud-hosted) assistants. This assistant uses '${cloud}'.`,
      );
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
    cloudUrl: getCloudUrl(),
  };
}

