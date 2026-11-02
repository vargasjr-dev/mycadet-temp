/**
 * The docker topology's specifics: the upgrade (pull the recorded images'
 * new tags, swap the containers, migrate, roll back on failure), the wake
 * and recreate paths, the image capture, and the hatch's CLI ceremony shell
 * around the package's provision core.
 */
import cliPkg from "../../../package.json";
import { platform } from "os";

import {
  dockerResourceNames,
  hatchAssistant as hatchAssistantOp,
  loopbackSafeFetch,
  pullImage,
  resolveImageRefs,
  saveLockfileAssistant,
  sleepDocker,
  startContainers,
  stopContainers,
  type ServiceName,
} from "@mycadet/local-mode";
import {
  type DockerAssistant,
  type LockfileAssistant,
  getGatewayUrl,
} from "@mycadet/local-mode/contract";
import { restoreContainerAppServer } from "../tunnel.js";
import {
  ASSISTANT_INTERNAL_PORT,
  GATEWAY_INTERNAL_PORT,
} from "../environments/paths.js";
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
import { compareVersions, versionsEqual } from "../version-compat.js";
import { ensureDockerDaemonRunning } from "@mycadet/local-mode";
import { getOrCreateHostDeviceId } from "@mycadet/local-mode";
import { exec, execOutput } from "../step-runner";
import {
  closeLogFile,
  openLogFile,
  resetLogFile,
  writeToLogFile,
} from "@mycadet/local-mode";
import { logHatchNextSteps } from "../hatch-next-steps.js";
import {
  collectProviderApiKey,
  promptProviderChoice,
  resolveHatchProvider,
  shouldPromptForHatchProvider,
} from "../provider-secrets.js";
import { checkProviderApiKey } from "../api-key-check.js";

// ─── Folded from the former lib/docker.ts: the docker topology's full surface ───
// (hatch ceremony shell, containers lifecycle, images, watcher, retire)

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

  const { cesServiceToken, extraAssistantEnv, extraGatewayEnv } =
    await captureReplayState(res);

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
  await sleepDocker(entry);
  console.log("✅ Containers stopped\n");

  console.log("🚀 Starting upgraded containers...");
  await startContainers(
    {
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

        await sleepDocker(entry);

        await startContainers(
          {
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
            entry,
            backupPath,
            backupLabel: "pre-upgrade",
            res,
            containerOptions: {
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
            const restored = await restoreBackup(
              entry.assistantId,
              backupPath,
              {},
            );
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

// ─── Folded from the former lib/docker.ts: the docker topology's full surface ───
// (hatch, containers lifecycle, images, avatar device, watcher, retire)

/** Start existing stopped containers, ensuring a Docker daemon is up first (macOS only). */
export async function wakeContainers(
  res: ReturnType<typeof dockerResourceNames>,
): Promise<void> {
  if (platform() !== "linux") {
    await ensureDockerDaemonRunning();
  }
  for (const container of [
    res.assistantContainer,
    res.gatewayContainer,
    res.cesContainer,
  ]) {
    await exec("docker", ["start", container]);
  }
}

/** The `docker start` failure for a container that was never created. */
export function isNoSuchContainerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("No such container");
}

/**
 * Recreate a docker instance's service group from its lockfile entry — the
 * wake path for containers that don't exist yet. A migrated install has its
 * data in the volumes but no containers: nothing ever ran `docker run` for
 * it (v0.0.10 run feedback: `wake --all` died on "No such container:
 * <name>-assistant").
 *
 * Network and volume creates are idempotent; the three service containers
 * come up from the entry's recorded images (the migrator points those at
 * the installed cadet's release). The guardian bootstrap secret rides
 * through from the entry; the signing key and CES token are deliberately
 * NOT invented — with no env value the gateway and assistant load the
 * persisted trust material from their security volumes (a migrated install
 * keeps its own), matching the gateway's resolution order (env → file →
 * generate). Empty volumes just get fresh state on first boot.
 */
export async function recreateDockerContainers(
  entry: DockerAssistant,
): Promise<void> {
  const info = entry.containerInfo;
  if (!info?.assistantImage || !info.gatewayImage || !info.cesImage) {
    throw new Error(
      `no container images recorded for '${entry.assistantId}' — re-hatch or run \`cadet upgrade\` to set them`,
    );
  }
  const res = dockerResourceNames(entry.assistantId);
  const log = (msg: string): void => console.log(msg);

  // Clean slate for the create: an existing container (even a stopped one)
  // would collide with `docker run --name` (the upgrade path does the same).
  await stopContainers(res);

  try {
    await exec("docker", ["network", "inspect", res.network]);
  } catch {
    await exec("docker", ["network", "create", res.network]);
  }
  for (const vol of [
    res.socketVolume,
    res.assistantIpcVolume,
    res.gatewayIpcVolume,
    res.workspaceVolume,
    res.gatewaySecurityVolume,
    res.cesSecurityVolume,
  ]) {
    try {
      await exec("docker", ["volume", "inspect", vol]);
    } catch {
      await exec("docker", ["volume", "create", vol]);
    }
  }

  // The recorded images may not be on the machine yet (a migrated install
  // gets its refs written before anything pulled them) — a pull of an
  // already-present image is a cheap no-op.
  for (const image of [info.assistantImage, info.gatewayImage, info.cesImage]) {
    log(`📦 Pulling ${image}...`);
    await pullImage(image, log);
  }

  const gatewayPort = entry.port;
  const assistantPort = ASSISTANT_INTERNAL_PORT;
  const device = getOrCreateHostDeviceId();
  await startContainers(
    {
      extraAssistantEnv: { CADET_DEVICE_ID: device },
      extraGatewayEnv: { CADET_DEVICE_ID: device },
      gatewayPort,
      imageTags: {
        assistant: info.assistantImage,
        gateway: info.gatewayImage,
        "credential-executor": info.cesImage,
      },
      instanceName: entry.assistantId,
      res,
    },
    log,
  );

  // Persist what the recreation decided (the gateway port, the assistant
  // port when it defaulted) so plain `docker start` wakes work and clients
  // reach the right endpoints.
  saveLockfileAssistant({
    ...entry,
    port: gatewayPort,
    daemonPort: entry.daemonPort ?? assistantPort,
    containerInfo: info,
  });
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

/**
 * Build the set of paths the hot-reload watcher should observe, scoped to
 * each service's `src/` tree, `package.json` manifest, and `Dockerfile`.
 *
 * We deliberately avoid recursively watching whole service directories.
 * Those contain `.claude/` command symlinks — which dangle in a fresh
 * checkout because they point at the separately-cloned `claude-skills`
 * repo — as well as `node_modules`. `fs.watch(dir, { recursive: true })`
 * traverses those entries and emits an unhandled `error` event on a broken
 * symlink, which crashes the CLI process. Source code only ever lives under
 * `src/`, so watching that tree plus the two manifests that drive the image
 * build (`package.json` and `Dockerfile`) preserves hot-reload without
 * walking into symlinked or generated trees. The `Dockerfile` is watched as
 * an individual file for the same reason — editing build steps should
 * trigger a rebuild, but the file sits next to the symlinked trees we avoid.
 *
 * Returning a plain record keeps this trivially unit-testable — see
 * `__tests__/docker.test.ts`.
 */
export interface HatchDockerParams {
  /** Instance display name. Defaults to an auto-generated name. */
  name?: string | null;
  /** Build from a local source tree and hot-reload on change. */
  watch?: boolean;
  /** Hatch-time config values (key → value). */
  configValues?: Record<string, string>;
  setupProviderCredentials?: boolean;
  /**
   * Path to a local source tree to build images from before hatching. When
   * provided, this path is used directly as the repo root and no file
   * watcher is started — useful for callers (e.g. evals) that want each
   * run to pick up local CLI changes without keeping a long-lived watcher
   * process around. `--watch` independently auto-detects the repo root and
   * also enables hot-reload.
   */
  sourcePath?: string | null;
  /**
   * Name of an existing container whose network namespace the assistant,
   * gateway, and credential-executor join (`--network=container:<name>`),
   * instead of the assistant owning a freshly-created per-instance network.
   * When set, hatch creates no Docker network and publishes no host ports —
   * the namespace owner is responsible for publishing the gateway port — so
   * `gatewayPort` must also be supplied (the owner had to publish it before
   * hatch ran).
   */
  netnsContainer?: string;
  /**
   * Explicit host port to record as the entry's gatewayPort instead of
   * auto-allocating a free port. Required alongside `netnsContainer`, where
   * the namespace owner — not hatch — owns port allocation and publishing.
   */
  gatewayPort?: number;
  /**
   * Host path to a PEM CA bundle bind-mounted into the assistant container
   * and trusted at process start via `NODE_EXTRA_CA_CERTS`. Lets the daemon
   * trust a TLS-terminating egress proxy from its very first outbound
   * connection.
   */
  assistantCaCertPath?: string;
}

export async function hatchDocker(params: HatchDockerParams): Promise<void> {
  const { name = null, configValues = {} } = params;

  resetLogFile("hatch.log");
  const setupProviderCredentials = params.setupProviderCredentials !== false;
  let provider = setupProviderCredentials
    ? resolveHatchProvider(configValues)
    : undefined;
  let precollectedApiKey: string | undefined;

  if (
    shouldPromptForHatchProvider({
      configValues,
      setupProviderCredentials,
      hasProviderApiKey: checkProviderApiKey().hasKey,
      stdinIsTTY: process.stdin.isTTY,
    })
  ) {
    const picked = await promptProviderChoice();
    if (picked) {
      provider = picked;
      // Collect the key immediately, while the choice is fresh — the
      // startup logs are quiet now, so nothing separates the two prompts.
      precollectedApiKey = await collectProviderApiKey(picked);
    }
  }

  let logFd = openLogFile("hatch.log");
  const log = (msg: string): void => {
    console.log(msg);
    writeToLogFile(logFd, `${new Date().toISOString()} ${msg}\n`);
  };

  try {
    // The provision core (toolchain, images, resources, containers,
    // readiness, the guardian lease, provider credential setup, and the
    // watch-mode rebuild loop) lives in the package now — the CLI's
    // ceremony around it is the provider prompts above, the hatch log
    // file, and the next-steps banner below.
    const result = await hatchAssistantOp({
      remote: "docker",
      name,
      watch: params.watch,
      configValues,
      sourcePath: params.sourcePath,
      netnsContainer: params.netnsContainer,
      gatewayPort: params.gatewayPort,
      assistantCaCertPath: params.assistantCaCertPath,
      version: cliPkg.version,
      provider,
      precollectedApiKey,
      log,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    if (result.ready) {
      logHatchNextSteps(log);
    }
  } finally {
    closeLogFile(logFd);
    logFd = "ignore";
  }
}

export async function dockerPair(entry: DockerAssistant): Promise<string> {
  return execOutput(
    "docker",
    [
      "exec",
      dockerResourceNames(entry.assistantId).gatewayContainer,
      "bun",
      "run",
      "src/cli/index.ts",
      "pairing",
      "mint",
    ],
    { timeoutMs: 30_000 },
  );
}
