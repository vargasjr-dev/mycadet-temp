import { isCloudHome } from "../lib/cloud-values.js";
import {
  findAssistantByName,
  getActiveAssistant,
  loadAllAssistants,
  type AssistantEntry,
} from "../lib/assistant-config";
import { emitCliError, categorizeUpgradeError } from "../lib/cli-error.js";
import { readCloudToken, rollbackCloudAssistant } from "../lib/cloud-client.js";
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  fetchCurrentVersion,
  fetchPreviousVersion,
  performDockerRollback,
} from "../lib/upgrade-lifecycle.js";

function parseArgs(): { name: string | null; version: string | null } {
  const args = process.argv.slice(3);
  let name: string | null = null;
  let version: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: cadet rollback [<name>] [--version <version>]");
      console.log("");
      console.log(
        "Roll back a Docker or cloud assistant to a previous version.",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>               Name of the assistant, defaults to active or only assistant",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --version <version>  Target version; omit to roll back to the previous version",
      );
      console.log("");
      console.log("Examples:");
      console.log(
        "  cadet rollback my-assistant                  # Roll back to previous version (Docker or managed)",
      );
      console.log(
        "  cadet rollback my-assistant --version v1.2.3 # Roll back to a specific version",
      );
      process.exit(0);
    } else if (arg === "--version") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --version requires a value");
        emitCliError("UNKNOWN", "--version requires a value");
        process.exit(1);
      }
      version = next;
      i++;
    } else if (!arg.startsWith("-")) {
      name = arg;
    } else {
      console.error(`Error: Unknown option '${arg}'.`);
      emitCliError("UNKNOWN", `Unknown option '${arg}'`);
      process.exit(1);
    }
  }

  return { name, version };
}

/**
 * Resolve which assistant to target for the rollback command. Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `cadet use`
 * 3. Sole assistant (when exactly one exists)
 */
function resolveTargetAssistant(nameArg: string | null): AssistantEntry {
  if (nameArg) {
    const entry = findAssistantByName(nameArg);
    if (!entry) {
      console.error(`No assistant found with name '${nameArg}'.`);
      emitCliError(
        "ASSISTANT_NOT_FOUND",
        `No assistant found with name '${nameArg}'.`,
      );
      process.exit(1);
    }
    return entry;
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
  }

  const all = loadAllAssistants();
  if (all.length === 1) return all[0];

  if (all.length === 0) {
    const msg = "No assistants found. Run 'cadet hatch' first.";
    console.error(msg);
    emitCliError("ASSISTANT_NOT_FOUND", msg);
  } else {
    const msg =
      "Multiple assistants found. Specify a name or set an active assistant with 'cadet use <name>'.";
    console.error(msg);
    emitCliError("ASSISTANT_NOT_FOUND", msg);
  }
  process.exit(1);
}

async function rollbackPlatformViaEndpoint(
  entry: AssistantEntry,
  version?: string,
): Promise<void> {
  // Step 1 — Authenticate
  const token = readCloudToken();
  if (!token) {
    const msg =
      "Error: Not logged in. Run `cadet login --token <token>` first.";
    console.error(msg);
    emitCliError("AUTH_FAILED", msg);
    process.exit(1);
  }

  // Fetch current version from health endpoint (best-effort)
  const currentVersion = await fetchCurrentVersion(entry.runtimeUrl);

  // Step 3 — Call rollback endpoint
  if (version) {
    console.log(`Rolling back to ${version}...`);
  } else {
    console.log("Rolling back to previous version...");
  }

  let result: { detail: string; version: string | null };
  try {
    result = await rollbackCloudAssistant(
      token,
      entry.assistantId,
      version,
      entry.runtimeUrl,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    // Map specific server error messages to actionable CLI output
    if (detail.includes("No previous version")) {
      console.error(
        "No previous version available. A successful upgrade must have been performed first.",
      );
    } else if (detail.includes("not older")) {
      console.error(
        `Target version is not older than the current version. Use 'cadet upgrade --version' instead.`,
      );
    } else if (detail.includes("not found")) {
      console.error(
        version
          ? `Version ${version} not found.`
          : `Rollback target not found.`,
      );
    } else if (
      err instanceof TypeError ||
      detail.includes("fetch failed") ||
      detail.includes("ECONNREFUSED")
    ) {
      console.error(
        `Connection error: ${detail}\nIs Cadet Cloud reachable? Try 'cadet wake' if the assistant is asleep.`,
      );
    } else {
      console.error(`Error: ${detail}`);
    }

    emitCliError("PLATFORM_API_ERROR", "Cadet Cloud rollback failed", detail);
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(currentVersion ?? version ?? "unknown", false),
    );
    process.exit(1);
  }

  const rolledBackVersion = result.version ?? version ?? "unknown";

  // Step 4 — Print success
  console.log(`Rolled back to version ${rolledBackVersion}.`);
  if (!version) {
    console.log("Tip: Run 'cadet rollback' again to undo.");
  }
}

export const rollback = Object.assign(
  async function rollback(): Promise<void> {
    const { name, version } = parseArgs();
    const entry = resolveTargetAssistant(name);
    const cloud = entry.cloud;

    if (cloud === "apple-container") {
      console.error(
        `Error: '${entry.assistantId}' uses the Apple Containers runtime. Rollback is not yet supported for this topology.`,
      );
      process.exit(1);
    }

    // ---------- Managed (Cadet Cloud) rollback ----------
    if (isCloudHome(cloud)) {
      await rollbackPlatformViaEndpoint(entry, version ?? undefined);
      return;
    }

    // ---------- Unsupported topologies ----------
    if (cloud !== "docker") {
      const msg = "Rollback is only supported for Docker and cloud assistants.";
      console.error(msg);
      emitCliError("UNSUPPORTED_TOPOLOGY", msg);
      process.exit(1);
    }

    let targetVersion = version ?? undefined;
    if (!targetVersion) {
      const currentVersion = await fetchCurrentVersion(entry.runtimeUrl);
      targetVersion = await fetchPreviousVersion(
        currentVersion,
        entry.previousVersion,
      );
      if (!targetVersion) {
        const msg =
          "No previous version available. Specify --version <version> to choose a rollback target.";
        console.error(msg);
        emitCliError("ROLLBACK_NO_STATE", msg);
        process.exit(1);
      }
    }
    try {
      await performDockerRollback(entry, { targetVersion });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Rollback failed: ${detail}`);
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildCompleteEvent(targetVersion ?? "unknown", false),
      );
      emitCliError(categorizeUpgradeError(err), "Rollback failed", detail);
      process.exit(1);
    }
  },
  { description: "Roll back an assistant to a previous version" },
);
