/**
 * The docker upgrade leg: pull the recorded images' new tags, swap the
 * containers, migrate, and roll back on failure — with the wake and the
 * image capture it needs, and the lifecycle's replay/recovery core behind
 * it. Narration rides the caller's reporter; failures throw `UpgradeError`
 * for the command layer to map onto the CLI's error taxonomy.
 */
import { platform } from "node:os";

import { pullImage, resolveImageRefs } from "./hatch";
import { dockerResourceNames } from "./retire";
import { ensureDockerDaemonRunning } from "./common";
import { sleepDocker } from "./sleep";
import { type ServiceName } from "./statefulset";
import { saveLockfileAssistant } from "../../lockfile";
import { GATEWAY_INTERNAL_PORT } from "../../ports";
import {
  type DockerAssistant,
  type LockfileAssistant,
  getGatewayUrl,
} from "../../lockfile-contract";
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
  UpgradeError,
} from "../../upgrade-lifecycle";
import { wakeDocker } from "./wake";
import type { LifecycleReporter } from "../../lifecycle-reporter";
import { createBackup, pruneOldBackups, restoreBackup } from "../../backup-ops";
import { compareVersions, versionsEqual } from "../../version-compat";
import { exec, execOutput } from "../../exec";
import { loopbackSafeFetch } from "../../loopback-fetch";

export interface UpgradeDockerParams {
  entry: DockerAssistant;
  /** The target version tag; null = the caller's own release. */
  version: string | null;
  /** The caller's own release version — the fallback image tag. */
  cliVersion: string;
  force: boolean;
  reporter: LifecycleReporter;
}

export async function upgradeDocker(
  params: UpgradeDockerParams,
): Promise<void> {
  const { reporter } = params;
  const log = (msg: string) => reporter.log(msg);
  const warn = (msg: string) => reporter.warn(msg);
  const err = (msg: string) => reporter.error(msg);
  const entry = params.entry;
  const version = params.version;
  const force = params.force;
  const gatewayUrl = getGatewayUrl(entry);
  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);

  const versionTag =
    version ?? (params.cliVersion ? `v${params.cliVersion}` : "latest");

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
    warn(
      "⚠️  Could not determine current version from health endpoint — skipping version-direction check.\n",
    );
  }
  if (currentVersion && versionTag) {
    const cmp = compareVersions(versionTag, currentVersion);
    if (cmp !== null && cmp < 0) {
      throw new UpgradeError(
        "VERSION_DIRECTION",
        `Cannot upgrade to an older version (${versionTag} < ${currentVersion}). Use \`cadet restore --from <backup-path> --version ${versionTag}\` instead.`,
      );
    }
  }

  // No-op guard: skip the full stop/start cycle (real downtime) when already
  // on the target version. --force allows an intentional reinstall/repair.
  if (currentVersion && versionsEqual(versionTag, currentVersion)) {
    if (!force) {
      log(
        `✅ Already on ${versionTag}. Nothing to do. Pass --force to reinstall.`,
      );
      return;
    }
    log(`🔁 Reinstalling ${versionTag} with --force...\n`);
  }

  log("🔍 Resolving image references...");
  const imageTags = resolveImageRefs(versionTag, params.cliVersion);

  log(`🔄 Upgrading Docker assistant '${instanceName}' to ${versionTag}...\n`);

  // Capture rollback state from existing containers BEFORE pulling new
  // images or stopping anything.  captureImageRefs uses the immutable
  // image digest ({{.Image}}), but capturing first keeps the intent
  // explicit and avoids relying on container-inspect ordering subtleties.
  log("📸 Capturing current image references for rollback...");
  const previousImageRefs = await captureImageRefs(res);
  if (previousImageRefs) {
    log(
      `   Captured refs for ${Object.keys(previousImageRefs).length} service(s)\n`,
    );
  } else {
    log(
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

  const { extraAssistantEnv, extraGatewayEnv } = await captureReplayState(res);

  // Notify connected clients that an upgrade is about to begin.
  // This must fire BEFORE any progress broadcasts so the UI sets
  // isUpdateInProgress = true and starts displaying status messages.
  log("📢 Notifying connected clients...");
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
  log("📦 Pulling new Docker images...");
  const pullImages: Array<[string, string]> = [
    ["assistant", imageTags.assistant],
    ["gateway", imageTags.gateway],
    ["credential-executor", imageTags["credential-executor"]],
  ];
  try {
    for (const [service, image] of pullImages) {
      log(`   Pulling ${service}: ${image}`);
      await pullImage(image);
    }
  } catch (pullErr) {
    const detail = pullErr instanceof Error ? pullErr.message : String(pullErr);
    err(`\n❌ Failed to pull Docker images: ${detail}`);
    await broadcastUpgradeEvent(
      gatewayUrl,
      entry.assistantId,
      buildCompleteEvent(currentVersion ?? "unknown", false),
    );
    throw new UpgradeError(
      "IMAGE_PULL_FAILED",
      "Failed to pull Docker images",
      detail,
    );
  }
  log("✅ Docker images pulled\n");

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

  // Capture complete persistent roots before replacing any services.
  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.BACKING_UP),
  );
  log("📦 Creating pre-upgrade backup...");
  const backupPath = await createBackup(entry.assistantId, {
    prefix: `${entry.assistantId}-pre-upgrade`,
    description: `Pre-upgrade snapshot before ${currentVersion ?? "unknown"} → ${versionTag}`,
  });
  if (backupPath) {
    log(`   Backup saved: ${backupPath}\n`);
    // Clean up old pre-upgrade backups, keep last 3
    pruneOldBackups(entry.assistantId, 3);
  } else {
    warn(
      "⚠️  Pre-upgrade backup failed — continuing WITHOUT a backup; this upgrade cannot be rolled back from one.",
    );
  }

  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.INSTALLING),
  );

  log("🛑 Stopping existing containers...");
  await sleepDocker(entry);
  log("✅ Containers stopped\n");

  log("🚀 Starting upgraded containers...");
  const wake = await wakeDocker(entry, {
    extraAssistantEnv,
    extraGatewayEnv,
    gatewayPort,
    imageTags,
    waitUntilReady: true,
    log: (msg) => log(msg),
  });
  const ready = wake.ok;
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

    log(`\n✅ Docker assistant '${instanceName}' upgraded to ${versionTag}.`);
  } else {
    err(`\n❌ Containers failed to become ready within the timeout.`);

    const logDir = await captureUpgradeFailureLogs(
      res,
      `${instanceName}-upgrade-failure`,
    );
    if (logDir) {
      log(`📋 Container logs saved to: ${logDir}`);
    }

    if (previousImageRefs) {
      await broadcastUpgradeEvent(
        gatewayUrl,
        entry.assistantId,
        buildProgressEvent(UPGRADE_PROGRESS.REVERTING),
      );
      log(`\n🔄 Rolling back to previous images...`);
      try {
        // Attempt to roll back migrations before swapping containers.
        // The new daemon may be partially up — try best-effort.
        if (
          preMigrationState.dbVersion !== undefined ||
          preMigrationState.lastWorkspaceMigrationId !== undefined
        ) {
          log("🔄 Reverting database changes...");
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

        await sleepDocker(entry);

        const rollbackWake = await wakeDocker(entry, {
          extraAssistantEnv,
          extraGatewayEnv,
          gatewayPort,
          imageTags: previousImageRefs,
          waitUntilReady: true,
          log: (msg) => log(msg),
        });
        let rollbackReady = rollbackWake.ok;
        let restoredViaFailedState = false;
        if (!rollbackReady && backupPath) {
          const recovery = await attemptFailedStateRestore({
            runtimeUrl: gatewayUrl,
            entry,
            backupPath,
            backupLabel: "pre-upgrade",
            res,
            containerOptions: {
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
            log("   ✅ Data restored during failed-state recovery above\n");
          } else if (backupPath) {
            await broadcastUpgradeEvent(
              gatewayUrl,
              entry.assistantId,
              buildProgressEvent(UPGRADE_PROGRESS.RESTORING),
            );
            log(`📦 Restoring data from pre-upgrade backup...`);
            log(`   Source: ${backupPath}`);
            const restored = await restoreBackup(
              entry.assistantId,
              backupPath,
              {},
            );
            if (restored) {
              log("   ✅ Data restored successfully\n");
            } else {
              throw new Error(
                `Root restore failed; rollback recovery is incomplete. Backup: ${backupPath}`,
              );
            }
          } else {
            log(
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

          throw new UpgradeError(
            "READINESS_TIMEOUT",
            `Upgrade to ${versionTag} failed: containers did not become ready. Rolled back to previous version.`,
          );
        } else {
          throw new UpgradeError(
            "ROLLBACK_FAILED",
            "Rollback also failed after readiness timeout. Manual intervention required.",
          );
        }
      } catch (rollbackErr) {
        const rollbackDetail =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        throw new UpgradeError(
          "ROLLBACK_FAILED",
          "Auto-rollback failed after readiness timeout. Manual intervention required.",
          rollbackDetail,
        );
      }
    } else {
      throw new UpgradeError(
        "ROLLBACK_NO_STATE",
        "Containers failed to become ready and no previous images available for rollback.",
      );
    }
  }
}

/**
 * Capture the current image references for running service containers.
 * Returns a complete record of service → immutable image ID (sha256 digest)
 * for all three services. Uses `{{.Image}}` rather than `{{.Config.Image}}`
 * so rollback targets the exact image that was running, even if the tag has
 * since been retagged to a different image.
 *
 * Returns null if any container could not be inspected (e.g. fresh install
 * or partial deployment).
 */
export async function captureImageRefs(
  res: ReturnType<typeof dockerResourceNames>,
): Promise<Record<ServiceName, string> | null> {
  const containerForService: Record<ServiceName, string> = {
    assistant: res.assistantContainer,
    "credential-executor": res.cesContainer,
    gateway: res.gatewayContainer,
  };

  const refs: Partial<Record<ServiceName, string>> = {};

  for (const [service, container] of Object.entries(containerForService)) {
    try {
      const imageRef = (
        await execOutput("docker", [
          "inspect",
          "--format",
          "{{.Image}}",
          container,
        ])
      ).trim();
      if (imageRef) {
        refs[service as ServiceName] = imageRef;
      }
    } catch {
      // Container doesn't exist or can't be inspected — skip
    }
  }

  const allServices: ServiceName[] = [
    "assistant",
    "credential-executor",
    "gateway",
  ];
  const hasAll = allServices.every((s) => s in refs);
  return hasAll ? (refs as Record<ServiceName, string>) : null;
}
