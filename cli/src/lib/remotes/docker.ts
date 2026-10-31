/**
 * The docker assistant's upgrade: pull the recorded images' new tags, swap
 * the containers, migrate, and roll back to the previous images on failure.
 * Lives here — the docker topology's specifics — rather than in the upgrade
 * command, which only dispatches per topology.
 */
import cliPkg from "../../../package.json";
import {
  type DockerAssistant,
  type LockfileAssistant,
  getGatewayUrl,
} from "@mycadet/local-mode/contract";
import { saveLockfileAssistant } from "@mycadet/local-mode";
import {
  captureImageRefs,
  dockerResourceNames,
  GATEWAY_INTERNAL_PORT,
  pullImage,
  sleepContainers,
  startContainers,
  stopContainers,
} from "../docker.js";
import { restoreContainerAppServer } from "../tunnel.js";
import {
  attemptFailedStateRestore,
  broadcastUpgradeEvent,
  buildCompleteEvent,
  buildProgressEvent,
  buildStartingEvent,
  buildUpgradeCommitMessage,
  captureReplayState,
  captureUpgradeFailureLogs,
  commitWorkspaceViaGateway,
  rollbackMigrations,
  UPGRADE_PROGRESS,
  waitForReady,
} from "../upgrade-lifecycle.js";
import { createBackup, pruneOldBackups, restoreBackup } from "../backup-ops.js";
import { emitCliError } from "../cli-error.js";
import { loopbackSafeFetch } from "../loopback-fetch.js";
import { resolveImageRefs } from "../cloud-releases.js";
import { compareVersions, versionsEqual } from "../version-compat.js";

export async function upgradeDocker(
  entry: DockerAssistant,
  version: string | null,
  force: boolean,
): Promise<void> {
  const gatewayUrl = getGatewayUrl(entry);
  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);

  const versionTag =
    version ?? (cliPkg.version ? `v${cliPkg.version}` : "latest");

  // Capture current migration state and running version for rollback targeting
  // and version guards. Must happen while the daemon is still running (before
  // containers are stopped).
  let currentVersion: string | undefined;
  let preMigrationState: {
    dbVersion?: number;
    lastWorkspaceMigrationId?: string;
  } = {};
  try {
    const healthResp = await loopbackSafeFetch(
      `${gatewayUrl}/healthz?include=migrations`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    if (healthResp.ok) {
      const health = (await healthResp.json()) as {
        version?: string;
        migrations?: { dbVersion?: number; lastWorkspaceMigrationId?: string };
      };
      preMigrationState = health.migrations ?? {};
      currentVersion = health.version;
    }
  } catch {
    // Best-effort — if we can't get migration state, rollback will skip migration reversal
  }

  // Reject downgrades — `cadet upgrade` only handles forward version changes.
  // Downgrades require a versioned backup restore.
  if (!currentVersion && versionTag) {
    console.warn(
      "⚠️  Could not determine current version from health endpoint — skipping version-direction check.\n",
    );
  }
  if (currentVersion && versionTag) {
    const cmp = compareVersions(versionTag, currentVersion);
    if (cmp !== null && cmp < 0) {
      const msg = `Cannot upgrade to an older version (${versionTag} < ${currentVersion}). Use \`cadet restore --from <backup-path> --version ${versionTag}\` instead.`;
      console.error(msg);
      emitCliError("VERSION_DIRECTION", msg);
      process.exit(1);
    }
  }

  // No-op guard: skip the full stop/start cycle (real downtime) when already
  // on the target version. --force allows an intentional reinstall/repair.
  if (currentVersion && versionsEqual(versionTag, currentVersion)) {
    if (!force) {
      console.log(
        `✅ Already on ${versionTag}. Nothing to do. Pass --force to reinstall.`,
      );
      return;
    }
    console.log(`🔁 Reinstalling ${versionTag} with --force...\n`);
  }

  console.log("🔍 Resolving image references...");
  const imageTags = resolveImageRefs(versionTag, cliPkg.version ?? "");

  console.log(
    `🔄 Upgrading Docker assistant '${instanceName}' to ${versionTag}...\n`,
  );

  // Capture rollback state from existing containers BEFORE pulling new
  // images or stopping anything.  captureImageRefs uses the immutable
  // image digest ({{.Image}}), but capturing first keeps the intent
  // explicit and avoids relying on container-inspect ordering subtleties.
  console.log("📸 Capturing current image references for rollback...");
  const previousImageRefs = await captureImageRefs(res);
  if (previousImageRefs) {
    console.log(
      `   Captured refs for ${Object.keys(previousImageRefs).length} service(s)\n`,
    );
  } else {
    console.log(
      "   Could not capture all container refs (fresh install or partial deployment)\n",
    );
  }

  // Record version transition start in workspace git history
  await commitWorkspaceViaGateway(
    gatewayUrl,
    entry.assistantId,
    buildUpgradeCommitMessage({
      action: "upgrade",
      phase: "starting",
      from: currentVersion ?? "unknown",
      to: versionTag,
      topology: "docker",
      assistantId: entry.assistantId,
    }),
  );

  const {
    bootstrapSecret,
    cesServiceToken,
    extraAssistantEnv,
    extraGatewayEnv,
  } = await captureReplayState(res);

  // Notify connected clients that an upgrade is about to begin.
  // This must fire BEFORE any progress broadcasts so the UI sets
  // isUpdateInProgress = true and starts displaying status messages.
  console.log("📢 Notifying connected clients...");
  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildStartingEvent(versionTag),
  );
  // Brief pause to allow SSE delivery before progress events.
  await new Promise((r) => setTimeout(r, 500));

  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.DOWNLOADING),
  );
  console.log("📦 Pulling new Docker images...");
  const pullImages: Array<[string, string]> = [
    ["assistant", imageTags.assistant],
    ["gateway", imageTags.gateway],
    ["credential-executor", imageTags["credential-executor"]],
  ];
  try {
    for (const [service, image] of pullImages) {
      console.log(`   Pulling ${service}: ${image}`);
      await pullImage(image);
    }
  } catch (pullErr) {
    const detail = pullErr instanceof Error ? pullErr.message : String(pullErr);
    console.error(`\n❌ Failed to pull Docker images: ${detail}`);
    await broadcastUpgradeEvent(
      gatewayUrl,
      entry.assistantId,
      buildCompleteEvent(currentVersion ?? "unknown", false),
    );
    emitCliError("IMAGE_PULL_FAILED", "Failed to pull Docker images", detail);
    process.exit(1);
  }
  console.log("✅ Docker images pulled\n");

  // Derive the gateway port from the entry's canonical fields, fall back
  // to default.
  let gatewayPort = GATEWAY_INTERNAL_PORT;
  try {
    const parsed = new URL(gatewayUrl);
    const port = parseInt(parsed.port, 10);
    if (!isNaN(port)) {
      gatewayPort = port;
    }
  } catch {
    // use default
  }

  // Recover the assistant host port from the entry, fall back to default.

  // Capture complete persistent roots before replacing any services.
  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.BACKING_UP),
  );
  console.log("📦 Creating pre-upgrade backup...");
  const backupPath = await createBackup(entry.assistantId, {
    prefix: `${entry.assistantId}-pre-upgrade`,
    description: `Pre-upgrade snapshot before ${currentVersion ?? "unknown"} → ${versionTag}`,
  });
  if (backupPath) {
    console.log(`   Backup saved: ${backupPath}\n`);
    // Clean up old pre-upgrade backups, keep last 3
    pruneOldBackups(entry.assistantId, 3);
  } else {
    console.warn(
      "⚠️  Pre-upgrade backup failed — continuing WITHOUT a backup; this upgrade cannot be rolled back from one.",
    );
  }

  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.INSTALLING),
  );

  console.log("🛑 Stopping existing containers...");
  await sleepContainers(res);
  await stopContainers(res);
  console.log("✅ Containers stopped\n");

  console.log("🚀 Starting upgraded containers...");
  await startContainers(
    {
      bootstrapSecret,
      cesServiceToken,
      extraAssistantEnv,
      extraGatewayEnv,
      gatewayPort,
      imageTags,
      instanceName,
      res,
    },
    (msg) => console.log(msg),
  );
  console.log("✅ Containers started\n");

  console.log("Waiting for assistant to become ready...");
  const ready = await waitForReady(gatewayUrl);
  if (ready) {
    // Update lockfile with new service group topology
    const updatedEntry: LockfileAssistant = {
      ...entry,
      containerInfo: {
        assistantImage: imageTags.assistant,
        gatewayImage: imageTags.gateway,
        cesImage: imageTags["credential-executor"],
      },
    };
    saveLockfileAssistant(updatedEntry);
    // Refresh the host-served web bundle before clients reload on completion.
    await restoreContainerAppServer(updatedEntry);

    // Notify clients on the new service group that the upgrade succeeded.
    await broadcastUpgradeEvent(
      gatewayUrl,
      entry.assistantId,
      buildCompleteEvent(versionTag, true),
    );

    // Record successful upgrade in workspace git history
    await commitWorkspaceViaGateway(
      gatewayUrl,
      entry.assistantId,
      buildUpgradeCommitMessage({
        action: "upgrade",
        phase: "complete",
        from: currentVersion ?? "unknown",
        to: versionTag,
        topology: "docker",
        assistantId: entry.assistantId,
        result: "success",
      }),
    );

    console.log(
      `\n✅ Docker assistant '${instanceName}' upgraded to ${versionTag}.`,
    );
  } else {
    console.error(`\n❌ Containers failed to become ready within the timeout.`);

    const logDir = await captureUpgradeFailureLogs(
      res,
      `${instanceName}-upgrade-failure`,
    );
    if (logDir) {
      console.log(`📋 Container logs saved to: ${logDir}`);
    }

    if (previousImageRefs) {
      await broadcastUpgradeEvent(
        gatewayUrl,
        entry.assistantId,
        buildProgressEvent(UPGRADE_PROGRESS.REVERTING),
      );
      console.log(`\n🔄 Rolling back to previous images...`);
      try {
        // Attempt to roll back migrations before swapping containers.
        // The new daemon may be partially up — try best-effort.
        if (
          preMigrationState.dbVersion !== undefined ||
          preMigrationState.lastWorkspaceMigrationId !== undefined
        ) {
          console.log("🔄 Reverting database changes...");
          await broadcastUpgradeEvent(
            gatewayUrl,
            entry.assistantId,
            buildProgressEvent(UPGRADE_PROGRESS.REVERTING_MIGRATIONS),
          );
          await rollbackMigrations(
            gatewayUrl,
            entry.assistantId,
            preMigrationState.dbVersion,
            preMigrationState.lastWorkspaceMigrationId,
          );
        }

        await sleepContainers(res);
        await stopContainers(res);

        await startContainers(
          {
            bootstrapSecret,
            cesServiceToken,
            extraAssistantEnv,
            extraGatewayEnv,
            gatewayPort,
            imageTags: previousImageRefs,
            instanceName,
            res,
          },
          (msg) => console.log(msg),
        );

        let rollbackReady = await waitForReady(gatewayUrl);
        let restoredViaFailedState = false;
        if (!rollbackReady && backupPath) {
          const recovery = await attemptFailedStateRestore({
            runtimeUrl: gatewayUrl,
            assistantId: entry.assistantId,
            backupPath,
            backupLabel: "pre-upgrade",
            res,
            containerOptions: {
              bootstrapSecret,
              cesServiceToken,
              extraAssistantEnv,
              extraGatewayEnv,
              gatewayPort,
              imageTags: previousImageRefs,
              instanceName,
              res,
            },
          });
          restoredViaFailedState = recovery.restored;
          if (recovery.restored) {
            rollbackReady = recovery.ready;
          }
        }
        if (rollbackReady) {
          // Restore data from the backup created for THIS upgrade attempt.
          // Only use the specific backupPath — never scan for the latest
          // backup on disk, which could be from a previous upgrade cycle
          // and contain stale data.
          if (restoredViaFailedState) {
            console.log(
              "   ✅ Data restored during failed-state recovery above\n",
            );
          } else if (backupPath) {
            await broadcastUpgradeEvent(
              gatewayUrl,
              entry.assistantId,
              buildProgressEvent(UPGRADE_PROGRESS.RESTORING),
            );
            console.log(`📦 Restoring data from pre-upgrade backup...`);
            console.log(`   Source: ${backupPath}`);
            const restored = await restoreBackup(entry.assistantId, backupPath, {});
            if (restored) {
              console.log("   ✅ Data restored successfully\n");
            } else {
              throw new Error(
                `Root restore failed; rollback recovery is incomplete. Backup: ${backupPath}`,
              );
            }
          } else {
            console.log(
              "ℹ️  No pre-upgrade backup was created for this attempt, skipping data restoration\n",
            );
          }

          // Restore previous container info in lockfile after rollback.
          // The recorded image refs are the rollback record now (digests are
          // gone from the contract).
          const rolledBackEntry: LockfileAssistant = {
            ...entry,
            containerInfo: {
              assistantImage:
                entry.containerInfo?.assistantImage ??
                previousImageRefs.assistant,
              gatewayImage:
                entry.containerInfo?.gatewayImage ?? previousImageRefs.gateway,
              cesImage:
                entry.containerInfo?.cesImage ??
                previousImageRefs["credential-executor"],
            },
          };
          saveLockfileAssistant(rolledBackEntry);
          // Notify clients that the upgrade failed and rolled back.
          await broadcastUpgradeEvent(
            gatewayUrl,
            entry.assistantId,
            buildCompleteEvent(
              currentVersion ?? "unknown",
              false,
              currentVersion,
            ),
          );

          console.log(
            `\n⚠️  Rolled back to previous version. Upgrade to ${versionTag} failed.`,
          );
          emitCliError(
            "READINESS_TIMEOUT",
            `Upgrade to ${versionTag} failed: containers did not become ready. Rolled back to previous version.`,
          );
        } else {
          console.error(
            `\n❌ Rollback also failed. Manual intervention required.`,
          );
          console.log(
            `   Check logs with: docker logs -f ${res.assistantContainer}`,
          );
          await broadcastUpgradeEvent(
            gatewayUrl,
            entry.assistantId,
            buildCompleteEvent(currentVersion ?? "unknown", false),
          );
          emitCliError(
            "ROLLBACK_FAILED",
            "Rollback also failed after readiness timeout. Manual intervention required.",
          );
        }
      } catch (rollbackErr) {
        const rollbackDetail =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        console.error(`\n❌ Rollback failed: ${rollbackDetail}`);
        console.error(`   Manual intervention required.`);
        console.log(
          `   Check logs with: docker logs -f ${res.assistantContainer}`,
        );
        await broadcastUpgradeEvent(
          gatewayUrl,
          entry.assistantId,
          buildCompleteEvent(currentVersion ?? "unknown", false),
        );
        emitCliError(
          "ROLLBACK_FAILED",
          "Auto-rollback failed after readiness timeout. Manual intervention required.",
          rollbackDetail,
        );
      }
    } else {
      console.log(`   No previous images available for rollback.`);
      console.log(
        `   Check logs with: docker logs -f ${res.assistantContainer}`,
      );
      await broadcastUpgradeEvent(
        gatewayUrl,
        entry.assistantId,
        buildCompleteEvent(currentVersion ?? "unknown", false),
      );
      emitCliError(
        "ROLLBACK_NO_STATE",
        "Containers failed to become ready and no previous images available for rollback.",
      );
    }

    process.exit(1);
  }
}
