import { formatGuardianRefreshCliFailure } from "@mycadet/local-mode";
import { cliCommand } from "../../lib/cli-name.js";
import { getGatewayUrl } from "../../lib/runtime-url.js";

import {
  type LockfileAssistant,
  resolveTargetAssistant,
  saveLockfileAssistant,
} from "../../lib/assistant-config.js";
import {
  GuardianLeasePermanentError,
  leaseGuardianToken,
  loadGuardianToken,
  refreshGuardianTokenResult,
  resetGuardianBootstrap,
} from "../../lib/guardian-token.js";
import { generateLocalSecret } from "../../lib/local.js";

function printUsage(): void {
  console.log(
    `Usage: ${cliCommand()} gateway token <subcommand> [assistantId]`,
  );
  console.log("");
  console.log("Manage gateway authentication tokens.");
  console.log("");
  console.log(
    "Omit the assistant id to target the active (or sole) assistant.",
  );
  console.log("");
  console.log("Subcommands:");
  console.log("  get       Print the current guardian access token");
  console.log(
    "  refresh   Refresh an expired access token and print it (self-repairs a spent credential)",
  );
}

/**
 * Re-provision the guardian credential in place via the gateway's bootstrap
 * reset — the same machinery `cadet wake --repair-guardian` runs, minus the
 * wake. NEVER points at `cadet hatch`: hatching creates a different assistant.
 * A fresh lease revokes other devices' paired tokens; callers say so on
 * stderr. Returns true on success (the newly leased token is persisted).
 */
async function repairGuardianCredential(
  entry: LockfileAssistant,
  gatewayUrl: string,
): Promise<boolean> {
  let bootstrapSecret = entry.guardianBootstrapSecret;
  if (!bootstrapSecret) {
    bootstrapSecret = generateLocalSecret();
    entry.guardianBootstrapSecret = bootstrapSecret;
    saveLockfileAssistant(entry);
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await resetGuardianBootstrap(gatewayUrl, bootstrapSecret);
      await leaseGuardianToken(gatewayUrl, entry.assistantId, bootstrapSecret);
      return true;
    } catch (err) {
      if (err instanceof GuardianLeasePermanentError) return false;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      }
    }
  }
  return false;
}

export async function gatewayToken(): Promise<void> {
  const args = process.argv.slice(4);
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
    printUsage();
    process.exit(0);
  }

  if (subcommand !== "get" && subcommand !== "refresh") {
    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }

  const nameArg = args[1];
  const entry = resolveTargetAssistant(nameArg);

  if (subcommand === "get") {
    const tokenData = loadGuardianToken(entry.assistantId);
    if (!tokenData) {
      console.error("No guardian token found for this assistant.");
      process.exit(1);
    }
    console.log(tokenData.accessToken);
    return;
  }

  const gatewayUrl = getGatewayUrl(entry);
  if (!gatewayUrl) {
    console.error("No gateway URL found for this assistant.");
    process.exit(1);
  }

  const refreshed = await refreshGuardianTokenResult(
    gatewayUrl,
    entry.assistantId,
  );
  if (!refreshed.ok) {
    // A spent credential (401 — expired/revoked refresh token) or a missing
    // token file (404) is recoverable in place: re-lease via the gateway's
    // bootstrap reset. The user explicitly invoked a refresh — this is the
    // sanctioned recovery, never `cadet hatch` (a different assistant).
    if (refreshed.status === 401 || refreshed.status === 404) {
      const repaired = await repairGuardianCredential(entry, gatewayUrl);
      if (repaired) {
        const freshToken = loadGuardianToken(entry.assistantId);
        if (freshToken) {
          console.error(
            "Re-provisioned guardian token (this revoked other devices' paired tokens).",
          );
          console.log(freshToken.accessToken);
          return;
        }
      }
      console.error("Guardian token could not be re-provisioned.");
      console.error(
        `Run \`cadet wake ${entry.assistantId} --repair-guardian\` to recover access.`,
      );
    }
    console.error(refreshed.error);
    console.error(
      formatGuardianRefreshCliFailure(refreshed.status, refreshed.error),
    );
    process.exit(1);
  }

  console.log(refreshed.token.accessToken);
}
