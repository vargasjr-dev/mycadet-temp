import { isManagedCloud } from "../lib/managed-cloud.js";
import {
  findAssistantByName,
  getActiveAssistant,
  loadAllAssistants,
  saveAssistantEntry,
  type AssistantEntry,
} from "../lib/assistant-config";
import {
  GATEWAY_INTERNAL_PORT,
  ASSISTANT_INTERNAL_PORT,
  dockerResourceNames,
  startContainers,
  stopContainers,
} from "../lib/docker";
import type { ServiceName } from "../lib/docker";
import { emitCliError, categorizeUpgradeError } from "../lib/cli-error.js";
import {
  readPlatformToken,
  rollbackPlatformAssistant,
} from "../lib/platform-client.js";
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  buildProgressEvent,
  buildStartingEvent,
  buildUpgradeCommitMessage,
  captureReplayState,
  commitWorkspaceViaGateway,
  fetchCurrentVersion,
  fetchPreviousVersion,
  performDockerRollback,
  rollbackMigrations,
  UPGRADE_PROGRESS,
  waitForReady,
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
        "Roll back a Docker or managed assistant to a previous version.",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>               Name of the assistant (default: active or only assistant)",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --version <version>  Target version (optional for managed — omit to roll back to previous)",
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
  const token = readPlatformToken();
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
    result = await rollbackPlatformAssistant(
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
  if (isManagedCloud(cloud)) {
    await rollbackPlatformViaEndpoint(entry, version ?? undefined);
    return;
  }

  // ---------- Unsupported topologies ----------
  if (cloud !== "docker") {
    const msg = "Rollback is only supported for Docker and managed assistants.";
    console.error(msg);
    emitCliError("UNSUPPORTED_TOPOLOGY", msg);
    process.exit(1);
  }

  // ---------- Docker: Targeted version rollback (--version specified) ----------
  if (version) {
    try {
      await performDockerRollback(entry, { targetVersion: version });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Rollback failed: ${detail}`);
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildCompleteEvent(version ?? "unknown", false),
      );
      emitCliError(categorizeUpgradeError(err), "Rollback failed", detail);
      process.exit(1);
    }
    return;
  }

  // ---------- Docker: Saved-state rollback (no --version) ----------

  // Fetch current + previous version from live APIs
  const currentVersion = await fetchCurrentVersion(entry.runtimeUrl);
  const previousVersion =
    (await fetchPreviousVersion(currentVersion, entry.previousVersion)) ??
    "unknown";

  // Verify rollback state exists
  if (!entry.previousContainerInfo) {
    const msg =
      "No rollback state available. Run `cadet upgrade` first to create a rollback point.";
    console.error(msg);
    emitCliError("ROLLBACK_NO_STATE", msg);
    process.exit(1);
  }

  // Roll back to the previous images. Older entries recorded per-service
  // digests (the image sha captured at upgrade time) — those are gone from
  // the contract now; the recorded image refs are the rollback target.
  const prev = entry.previousContainerInfo;
  if (!prev.assistantImage || !prev.gatewayImage || !prev.cesImage) {
    const msg =
      "Incomplete rollback state. Previous container image refs are missing.";
    console.error(msg);
    emitCliError("ROLLBACK_NO_STATE", msg);
    process.exit(1);
  }

  // Build image refs from the previous record
  const previousImageRefs: Record<ServiceName, string> = {
    assistant: prev.assistantImage,
    "credential-executor": prev.cesImage,
    gateway: prev.gatewayImage,
  };

  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);

  try {
    // Record rollback start in workspace git history
    await commitWorkspaceViaGateway(
      entry.runtimeUrl,
      entry.assistantId,
      buildUpgradeCommitMessage({
        action: "rollback",
        phase: "starting",
        from: currentVersion ?? "unknown",
        to: previousVersion,
        topology: "docker",
        assistantId: entry.assistantId,
      }),
    );

    console.log(
      `🔄 Rolling back Docker assistant '${instanceName}' to ${previousVersion}...\n`,
    );

    const {
      bootstrapSecret,
      cesServiceToken,
      signingKey,
      extraAssistantEnv,
      extraGatewayEnv,
    } = await captureReplayState(res);

    // Parse gateway port from entry's runtimeUrl, fall back to default
    let gatewayPort = GATEWAY_INTERNAL_PORT;
    try {
      const parsed = new URL(entry.runtimeUrl);
      const port = parseInt(parsed.port, 10);
      if (!isNaN(port)) {
        gatewayPort = port;
      }
    } catch {
      // use default
    }

    // Recover the assistant host port from the entry, fall back to default.
    const assistantPort =
      entry.containerInfo?.assistantPort ?? ASSISTANT_INTERNAL_PORT;

    // Notify connected clients that a rollback is about to begin (best-effort)
    console.log("📢 Notifying connected clients...");
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildStartingEvent(previousVersion),
    );
    // Brief pause to allow SSE delivery before containers stop.
    await new Promise((r) => setTimeout(r, 500));

    // Roll back migrations to pre-upgrade state (must happen before containers stop)
    if (
      entry.previousDbMigrationVersion !== undefined ||
      entry.previousWorkspaceMigrationId !== undefined
    ) {
      console.log("🔄 Reverting database changes...");
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildProgressEvent(UPGRADE_PROGRESS.REVERTING_MIGRATIONS),
      );
      await rollbackMigrations(
        entry.runtimeUrl,
        entry.assistantId,
        entry.previousDbMigrationVersion,
        entry.previousWorkspaceMigrationId,
      );
    }

    // Progress: switching version (must be sent BEFORE stopContainers)
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildProgressEvent(UPGRADE_PROGRESS.SWITCHING),
    );

    console.log("🛑 Stopping existing containers...");
    await stopContainers(res);
    console.log("✅ Containers stopped\n");

    console.log("🚀 Starting containers with previous version...");
    await startContainers(
      {
        signingKey,
        bootstrapSecret,
        cesServiceToken,
        extraAssistantEnv,
        extraGatewayEnv,
        gatewayPort,
        assistantPort,
        imageTags: previousImageRefs,
        instanceName,
        res,
      },
      (msg) => console.log(msg),
    );
    console.log("✅ Containers started\n");

    console.log("Waiting for assistant to become ready...");
    const ready = await waitForReady(entry.runtimeUrl);

    if (ready) {
      // Swap current/previous state to enable "rollback the rollback"
      const updatedEntry: AssistantEntry = {
        ...entry,
        containerInfo: {
          assistantImage: prev.assistantImage ?? previousImageRefs.assistant,
          gatewayImage: prev.gatewayImage ?? previousImageRefs.gateway,
          cesImage: prev.cesImage ?? previousImageRefs["credential-executor"],
          assistantPort,
        },
        previousContainerInfo: entry.containerInfo,
        // Clear the backup path — it belonged to the upgrade we just rolled back
        preUpgradeBackupPath: undefined,
        previousDbMigrationVersion: undefined,
        previousWorkspaceMigrationId: undefined,
      };
      saveAssistantEntry(updatedEntry);

      // Notify clients that the rollback succeeded
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildCompleteEvent(previousVersion, true),
      );

      // Record successful rollback in workspace git history
      await commitWorkspaceViaGateway(
        entry.runtimeUrl,
        entry.assistantId,
        buildUpgradeCommitMessage({
          action: "rollback",
          phase: "complete",
          from: currentVersion ?? "unknown",
          to: previousVersion,
          topology: "docker",
          assistantId: entry.assistantId,
          result: "success",
        }),
      );

      console.log(
        `\n✅ Docker assistant '${instanceName}' rolled back to ${previousVersion}.`,
      );
      console.log(
        "\nTip: To also restore data from before the upgrade, use `cadet restore --from <backup-path>`.",
      );
    } else {
      console.error(
        `\n❌ Containers failed to become ready within the timeout.`,
      );
      console.log(
        `   Check logs with: docker logs -f ${res.assistantContainer}`,
      );
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildCompleteEvent(previousVersion, false),
      );
      emitCliError(
        "READINESS_TIMEOUT",
        "Rolled-back containers failed to become ready within the timeout.",
      );
      process.exit(1);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Rollback failed: ${detail}`);
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(previousVersion, false),
    );
    emitCliError(categorizeUpgradeError(err), "Rollback failed", detail);
    process.exit(1);
  }
},
  { description: "Roll back an assistant to a previous version" },
);

