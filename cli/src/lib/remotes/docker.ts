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

import { randomBytes } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  watch as fsWatch,
} from "fs";
import { arch, platform } from "os";
import { dirname, join, resolve } from "path";

import { isDockerEntry } from "@mycadet/local-mode";
import { findAssistantByName, setActiveAssistant } from "../assistant-config";
import { buildHatchConfigValues, writeInitialConfig } from "../config-utils";
import { printInstanceDetails } from "../instance-details";
import { buildServiceRunArgs } from "../statefulset.js";
import { getOrCreateHostDeviceId } from "../device-id.js";
import { getDefaultPorts } from "../environments/paths.js";
import { green, yellow } from "../color.js";
import {
  leaseGuardianToken,
  loadGuardianBootstrapSecret,
  saveGuardianBootstrapSecret,
} from "../guardian-token";
import { logHatchNextSteps } from "../hatch-next-steps.js";
import { isCadetProcess, stopProcess } from "../process";
import { generateInstanceName } from "../random-name";
import {
  HOST_IMAGE_LOADER_URL,
  isLocalBuildRef,
  loadImageViaHost,
} from "../host-image-loader.js";
import { resolveOwnImageRefs } from "../cloud-releases.js";
import { isDevVersion } from "@mycadet/shared/version";
import {
  collectProviderApiKey,
  configureHatchProviderApiKey,
  promptProviderChoice,
  resolveHatchProvider,
  shouldPromptForHatchProvider,
} from "../provider-secrets.js";
import { checkProviderApiKey } from "../api-key-check.js";
import { findOpenPort } from "../port-allocator.js";
import { exec, execOutput, execWithStdin } from "../step-runner";
import {
  closeLogFile,
  openLogFile,
  resetLogFile,
  writeToLogFile,
} from "../xdg-log";

export type ServiceName = "assistant" | "credential-executor" | "gateway";

const DOCKERHUB_ORG = "mycadet";

export function dockerhubImages(
  cliVersion: string,
): Record<ServiceName, string> {
  const suffix = isDevVersion(cliVersion) ? "-dev" : "";
  return {
    assistant: `${DOCKERHUB_ORG}/mycadet-assistant${suffix}`,
    "credential-executor": `${DOCKERHUB_ORG}/mycadet-credential-executor${suffix}`,
    gateway: `${DOCKERHUB_ORG}/mycadet-gateway${suffix}`,
  };
}

import { classifyReadyzResponse } from "../http-client.js";

/** Max time to wait for the assistant container to emit the readiness sentinel. */
export const DOCKER_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** Default virtual-camera device path. Overridable via `CADET_AVATAR_DEVICE`. */
const DEFAULT_AVATAR_DEVICE_PATH = "/dev/video10";

/** Env var the assistant reads to discover its virtual-camera device path. */
export const AVATAR_DEVICE_ENV_VAR = "CADET_AVATAR_DEVICE";

/**
 * Resolve the avatar device path from the environment. Always returns a
 * value — the CLI unconditionally passes the device path to the assistant
 * container; the skill decides whether to use it.
 */
export function resolveAvatarDevicePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[AVATAR_DEVICE_ENV_VAR];
  return override && override.length > 0
    ? override
    : DEFAULT_AVATAR_DEVICE_PATH;
}

/** Default memory (GiB) allocated to the Colima VM. */
const COLIMA_DEFAULT_MEMORY_GIB = 8;

/** Directory for user-local binary installs (no sudo required). */

const LOCAL_BIN_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".local",
  "bin",
);

/**
 * Returns the macOS architecture suffix used by GitHub release artifacts.
 * Maps Node's `arch()` values to the names used in release URLs.
 */
function releaseArch(): string {
  const a = arch();
  if (a === "arm64") return "aarch64";
  if (a === "x64") return "x86_64";
  return a;
}

/**
 * Downloads a file from `url` to `destPath`, makes it executable, and returns
 * the destination path. Throws on failure.
 */
async function downloadBinary(
  url: string,
  destPath: string,
  label: string,
): Promise<void> {
  console.log(`  ⬇ Downloading ${label}...`);
  await exec("bash", [
    "-c",
    `curl -fsSL -o "${destPath}" "${url}" && chmod +x "${destPath}"`,
  ]);
}

/**
 * Downloads and extracts a `.tar.gz` archive into `destDir`.
 */
async function downloadAndExtract(
  url: string,
  destDir: string,
  label: string,
): Promise<void> {
  console.log(`  ⬇ Downloading ${label}...`);
  await exec("bash", ["-c", `curl -fsSL "${url}" | tar xz -C "${destDir}"`]);
}

/**
 * Installs Docker CLI (and Colima + Lima on macOS) by downloading pre-built
 * binaries directly into ~/.local/bin/. No Homebrew or sudo required.
 */
async function installDockerToolchain(): Promise<void> {
  const isMac = platform() === "darwin";
  const isLinux = platform() === "linux";

  mkdirSync(LOCAL_BIN_DIR, { recursive: true });

  const cpuArch = releaseArch();

  if (isLinux) {
    // On Linux, Docker runs natively — only need the Docker CLI.
    console.log(
      "🐳 Docker not found. Installing Docker CLI to ~/.local/bin/...",
    );

    const dockerArch = cpuArch === "aarch64" ? "aarch64" : "x86_64";
    const dockerTarUrl = `https://download.docker.com/linux/static/stable/${dockerArch}/docker-27.5.1.tgz`;
    const dockerTmpDir = join(LOCAL_BIN_DIR, ".docker-tmp");
    mkdirSync(dockerTmpDir, { recursive: true });
    try {
      await downloadAndExtract(dockerTarUrl, dockerTmpDir, "Docker CLI");
      await exec("mv", [
        join(dockerTmpDir, "docker", "docker"),
        join(LOCAL_BIN_DIR, "docker"),
      ]);
      chmodSync(join(LOCAL_BIN_DIR, "docker"), 0o755);
    } finally {
      await exec("rm", ["-rf", dockerTmpDir]).catch(() => {});
    }

    if (!existsSync(join(LOCAL_BIN_DIR, "docker"))) {
      throw new Error(
        "docker binary not found after installation. Please install Docker manually: https://docs.docker.com/engine/install/",
      );
    }

    console.log("  ✅ Docker CLI installed to ~/.local/bin/");
    return;
  }

  if (!isMac) {
    throw new Error(
      "Automatic Docker installation is only supported on macOS and Linux. " +
        "Please install Docker manually: https://docs.docker.com/engine/install/",
    );
  }

  console.log(
    "🐳 Docker not found. Installing Docker, Colima, and Lima to ~/.local/bin/...",
  );

  // --- Docker CLI (macOS) ---
  // Docker publishes static binaries at download.docker.com.
  const dockerArch = cpuArch === "aarch64" ? "aarch64" : "x86_64";
  const dockerTarUrl = `https://download.docker.com/mac/static/stable/${dockerArch}/docker-27.5.1.tgz`;
  const dockerTmpDir = join(LOCAL_BIN_DIR, ".docker-tmp");
  mkdirSync(dockerTmpDir, { recursive: true });
  try {
    await downloadAndExtract(dockerTarUrl, dockerTmpDir, "Docker CLI");
    // The archive extracts to docker/docker — move it to our bin dir.
    await exec("mv", [
      join(dockerTmpDir, "docker", "docker"),
      join(LOCAL_BIN_DIR, "docker"),
    ]);
    chmodSync(join(LOCAL_BIN_DIR, "docker"), 0o755);
  } finally {
    await exec("rm", ["-rf", dockerTmpDir]).catch(() => {});
  }

  // --- Colima ---
  const colimaArch = cpuArch === "aarch64" ? "arm64" : "x86_64";
  const colimaUrl = `https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${colimaArch}`;
  await downloadBinary(colimaUrl, join(LOCAL_BIN_DIR, "colima"), "Colima");

  // --- Lima ---
  // Lima publishes tar.gz archives with bin/limactl and other tools.
  const limaArch = cpuArch === "aarch64" ? "arm64" : "x86_64";
  const limaVersionUrl =
    "https://api.github.com/repos/lima-vm/lima/releases/latest";
  let limaVersion: string;
  try {
    const resp = await fetch(limaVersionUrl);
    if (!resp.ok) {
      throw new Error(
        `GitHub API returned ${resp.status}` +
          (resp.status === 403
            ? " (rate-limited) — try again later."
            : `. Check your network connection.`),
      );
    }
    const data = (await resp.json()) as { tag_name?: string };
    if (!data.tag_name) {
      throw new Error("GitHub API response missing tag_name.");
    }
    limaVersion = data.tag_name; // e.g. "v1.0.3"
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch latest Lima version: ${message}`);
  }
  const limaVersionNum = limaVersion.replace(/^v/, ""); // "1.0.3"
  const limaTarUrl = `https://github.com/lima-vm/lima/releases/download/${limaVersion}/lima-${limaVersionNum}-Darwin-${limaArch}.tar.gz`;
  // Lima archives contain bin/limactl, bin/lima, share/lima/..., so extract
  // into the parent (~/.local/) so that limactl lands in ~/.local/bin/.
  const localDir = dirname(LOCAL_BIN_DIR);
  await downloadAndExtract(limaTarUrl, localDir, "Lima");

  // Verify all binaries are in place.
  for (const bin of ["docker", "colima", "limactl"]) {
    if (!existsSync(join(LOCAL_BIN_DIR, bin))) {
      throw new Error(
        `${bin} binary not found after installation. Please install Docker manually.`,
      );
    }
  }

  console.log("  ✅ Docker toolchain installed to ~/.local/bin/");
}

/**
 * Ensures ~/.local/bin/ is on PATH for this process so that docker, colima,
 * and limactl are discoverable.
 */
function ensureLocalBinOnPath(): void {
  const currentPath = process.env.PATH || "";
  if (!currentPath.includes(LOCAL_BIN_DIR)) {
    process.env.PATH = `${LOCAL_BIN_DIR}:${currentPath}`;
  }
}

export interface HatchDockerParams {
  /** Instance display name. Defaults to an auto-generated name. */
  name?: string | null;
  /** Build from a local source tree and hot-reload on change. */
  watch?: boolean;
  /** Hatch-time config values (key → value). */
  configValues?: Record<string, string>;
  setupProviderCredentials?: boolean;
  /** Whole-installation state installed into stopped containers before startup. */
  initialArchive?: string;
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

export type DockerProviderCredentialSetupAction =
  | "configure"
  | "defer"
  | "missing-token"
  | "skip";

export function resolveDockerProviderCredentialSetupAction(options: {
  provider: string | null | undefined;
  guardianAccessToken?: string;
  detached: boolean;
  /**
   * Key — or an explicit skip ("") — collected from the user right after
   * they picked the provider. When present (even empty), the user already
   * answered at the prompt, so detached hatches configure (or report the
   * missing key) instead of deferring to a second `cadet setup` run.
   */
  precollectedKey?: string;
}): DockerProviderCredentialSetupAction {
  if (options.provider === undefined) return "skip";
  if (options.provider === null) return options.detached ? "skip" : "configure";
  if (options.detached) {
    if (options.precollectedKey !== undefined) {
      return options.guardianAccessToken ? "configure" : "missing-token";
    }
    return "defer";
  }
  if (!options.guardianAccessToken) return "missing-token";
  return "configure";
}

/** Time to wait for the Docker daemon to answer `docker info` after a Colima start. */
const COLIMA_SETTLE_TIMEOUT_MS = 15_000;

/** Poll `docker info` until the daemon answers or the timeout elapses. */
async function waitForDockerDaemon(
  execFn: typeof exec,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await execFn("docker", ["info"]);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Start Colima and wait for the Docker daemon to actually answer.
 *
 * `colima start` exiting 0 only means Colima's own state file says the VM is
 * up — that state can be stale (zombie VM after a host sleep or crash), in
 * which case start is a no-op ("already running, ignoring") while the daemon
 * inside stays dead. So success is decided by re-probing `docker info`, and a
 * failed probe triggers the manual-fix cycle: force-stop and start fresh.
 * Never `colima delete` — the VM disk holds every container image and volume.
 * `startArgs` carries extra flags (e.g. `--memory`) for a first start; the
 * wake path starts an existing instance bare.
 */
async function startColimaAndAwaitDaemon(
  execFn: typeof exec,
  log: (msg: string) => void,
  opts: { startArgs?: string[]; settleTimeoutMs?: number } = {},
): Promise<void> {
  const startArgs = opts.startArgs ?? [];
  const settleTimeoutMs = opts.settleTimeoutMs ?? COLIMA_SETTLE_TIMEOUT_MS;

  try {
    await execFn("colima", ["start", ...startArgs]);
  } catch (err) {
    // exec captures the child's output and only surfaces it in the error —
    // print it so a failed start is never silent.
    log(`⚠️  colima start failed: ${err instanceof Error ? err.message : err}`);
  }

  if (await waitForDockerDaemon(execFn, settleTimeoutMs)) return;

  log(
    "🔄 Colima state looks stale — restarting the VM (colima stop --force, then start)...",
  );
  await execFn("colima", ["stop", "--force"]).catch(() => {});
  try {
    await execFn("colima", ["start", ...startArgs]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to restart Colima. Please run 'colima stop --force && colima start' manually.\n${message}`,
    );
  }
  if (!(await waitForDockerDaemon(execFn, settleTimeoutMs))) {
    throw new Error(
      "Docker daemon is still not reachable after restarting Colima. " +
        "Check `colima status` and `docker info`, then try again.",
    );
  }
}

/**
 * Checks whether the `docker` CLI and daemon are available on the system.
 * Installs Colima and Docker via direct binary download if missing (no sudo
 * required), and starts Colima if the Docker daemon is not reachable.
 */
async function ensureDockerInstalled(): Promise<void> {
  // Always add ~/.local/bin to PATH so previously installed binaries are found.
  ensureLocalBinOnPath();

  const isLinux = platform() === "linux";

  // On Linux, Docker runs natively — only need the docker CLI + daemon.
  // On macOS, we also need Colima and Lima to provide a Linux VM.
  const toolchainComplete = await (async () => {
    try {
      await execOutput("docker", ["--version"]);
      if (!isLinux) {
        await execOutput("colima", ["version"]);
        await execOutput("limactl", ["--version"]);
      }
      return true;
    } catch {
      return false;
    }
  })();

  if (!toolchainComplete) {
    await installDockerToolchain();
    // Re-check PATH after install.
    ensureLocalBinOnPath();

    try {
      await execOutput("docker", ["--version"]);
    } catch {
      throw new Error(
        "Docker was installed but is still not available on PATH. " +
          "You may need to restart your terminal.",
      );
    }
  }

  // Verify the Docker daemon is reachable.
  try {
    await exec("docker", ["info"]);
  } catch {
    // On Linux, the daemon must already be running (systemd, etc.).
    if (isLinux) {
      throw new Error(
        "Docker daemon is not running. Please start it with 'sudo systemctl start docker' " +
          "or ensure the Docker service is enabled.",
      );
    }

    // On macOS, try starting Colima.
    let hasColima = false;
    try {
      await execOutput("colima", ["version"]);
      hasColima = true;
    } catch {
      // colima not found
    }

    if (!hasColima) {
      throw new Error(
        "Docker daemon is not running and Colima is not installed.\n" +
          "Please start Docker Desktop, or install Colima with 'brew install colima' and run 'colima start'.",
      );
    }

    console.log("🚀 Docker daemon not running. Starting Colima...");
    await startColimaAndAwaitDaemon(exec, console.log, {
      startArgs: ["--memory", String(COLIMA_DEFAULT_MEMORY_GIB)],
    });
  }
}

/** Derive the Docker resource names from the instance name. */
export function dockerResourceNames(instanceName: string) {
  return {
    assistantContainer: `${instanceName}-assistant`,
    assistantIpcVolume: `${instanceName}-assistant-ipc`,
    cesContainer: `${instanceName}-credential-executor`,
    cesSecurityVolume: `${instanceName}-ces-sec`,
    gatewayContainer: `${instanceName}-gateway`,
    gatewayIpcVolume: `${instanceName}-gateway-ipc`,
    gatewaySecurityVolume: `${instanceName}-gateway-sec`,
    network: `${instanceName}-net`,
    socketVolume: `${instanceName}-socket`,
    workspaceVolume: `${instanceName}-workspace`,
  };
}

/** Silently attempt to stop and remove a Docker container. */
export async function removeContainer(containerName: string): Promise<void> {
  try {
    await exec("docker", ["stop", containerName]);
  } catch {
    // container may not exist or already stopped
  }
  try {
    await exec("docker", ["rm", containerName]);
  } catch {
    // container may not exist or already removed
  }
}

/**
 * Error signatures Docker Hub returns when the host has STALE Docker Hub
 * credentials: an expired personal access token saved by a past
 * `docker login` gets attached to the pull, and Hub rejects the request
 * instead of falling back to anonymous access for a public image.
 */
export function isExpiredDockerHubCredentialError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /personal access token is expired|authentication required|unauthorized/i.test(
    message,
  );
}

/**
 * Pull an image, retrying once without stale credentials when Docker Hub
 * rejects the pull with an expired-token/auth error — public pulls need no
 * login, so `docker logout` (clears the stored Docker Hub credentials the
 * docker CLI attaches to pulls) costs nothing. Other failures propagate raw;
 * a still-failing auth retry is rethrown with actionable copy.
 */
export async function pullImage(
  ref: string,
  log: (msg: string) => void = console.log,
  execFn: typeof exec = exec,
): Promise<void> {
  try {
    await execFn("docker", ["pull", ref]);
    return;
  } catch (err) {
    if (!isExpiredDockerHubCredentialError(err)) throw err;
    log(
      `⚠️  Docker Hub rejected the pull of ${ref} with an expired-credential ` +
        `error — clearing stale Docker Hub login and retrying (public images ` +
        `need no credentials)...`,
    );
    await execFn("docker", ["logout"]).catch(() => {});
  }
  try {
    await execFn("docker", ["pull", ref]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to pull ${ref}.\n${message}\n` +
        `If the Docker daemon is not running, start it, e.g. 'colima start' on macOS. ` +
        `If the error mentions authentication, run 'docker logout' and check your ` +
        `Docker Hub credentials — public image pulls need none.`,
    );
  }
}

export async function retireDocker(name: string): Promise<void> {
  console.log(`\u{1F5D1}\ufe0f  Stopping Docker containers for '${name}'...\n`);

  // Stop the file watcher process if one is tracked for this instance.
  const entry = findAssistantByName(name);
  const watcherPid =
    entry && isDockerEntry(entry) && typeof entry.watcherPid === "number"
      ? entry.watcherPid
      : null;
  if (watcherPid !== null) {
    if (isCadetProcess(watcherPid)) {
      await stopProcess(watcherPid, "file-watcher");
    } else {
      console.log(
        `PID ${watcherPid} is not a cadet process — skipping stale file-watcher PID.`,
      );
    }
  }

  const res = dockerResourceNames(name);

  await removeContainer(res.cesContainer);
  await removeContainer(res.gatewayContainer);
  await removeContainer(res.assistantContainer);

  // Also clean up a legacy single-container instance if it exists
  await removeContainer(name);

  // Remove network and volumes
  try {
    await exec("docker", ["network", "rm", res.network]);
  } catch {
    // network may not exist
  }
  for (const vol of [
    res.socketVolume,
    res.assistantIpcVolume,
    res.gatewayIpcVolume,
    res.workspaceVolume,
    res.cesSecurityVolume,
    res.gatewaySecurityVolume,
  ]) {
    try {
      await exec("docker", ["volume", "rm", vol]);
    } catch {
      // volume may not exist
    }
  }

  // Future: consider stopping Colima VM when no Docker instances remain.
  // Considerations:
  // - Track whether Cadet started Colima (vs. the user already had it
  //   running for non-Cadet workloads) \u2014 e.g. via a dedicated Colima
  //   profile (`colima start --profile cadet`) or a sentinel file.
  // - Only stop if both conditions are met: no cross-env Docker instances
  //   AND Cadet owns the Colima lifecycle.

  console.log(`\u2705 Docker instance retired.`);
}

/**
 * Walk up from `startDir` looking for a directory that contains
 * `assistant/Dockerfile`. Returns the path if found, otherwise `undefined`.
 */
function walkUpForRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "assistant", "Dockerfile"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Returns `true` when the given root looks like a full source checkout
 * (has assistant source code), as opposed to a packaged `.app` bundle
 * that only contains the Dockerfiles.
 */
function hasFullSourceTree(root: string): boolean {
  return existsSync(join(root, "assistant", "package.json"));
}

/**
 * Decide which image-source path `hatchDocker` should take given the user
 * flags and a probe result for the source tree.
 *
 * - `watch` always wants source-build *and* file-watcher (when the source
 *   tree is available).
 * - `buildFromSource` wants source-build but no watcher — used by evals so
 *   each run picks up fresh CLI changes from the repo.
 * - Without either flag we pull the published images.
 * - If either flag was set but the source tree is missing (e.g. the CLI is
 *   running from a packaged .app bundle), fall back to pulling and surface
 *   the reason so the caller can log a warning.
 *
 * Returning a plain record keeps this trivially unit-testable — see
 * `__tests__/docker.test.ts`.
 */
export function resolveDockerHatchMode(opts: {
  watch: boolean;
  buildFromSource: boolean;
  fullSourceTreeAvailable: boolean;
}): { build: boolean; watcher: boolean; fellBackToPull: boolean } {
  const requested = opts.watch || opts.buildFromSource;
  if (!requested) {
    return { build: false, watcher: false, fellBackToPull: false };
  }
  if (!opts.fullSourceTreeAvailable) {
    return { build: false, watcher: false, fellBackToPull: true };
  }
  return { build: true, watcher: opts.watch, fellBackToPull: false };
}

/**
 * Locate the repository root by walking up from `cli/src/lib/` until we
 * find a directory containing the expected Dockerfiles.
 */
function findRepoRoot(): string {
  // cli/src/lib/ -> repo root (works when running from source via bun)
  const sourceTreeRoot = join(import.meta.dir, "..", "..", "..");
  if (existsSync(join(sourceTreeRoot, "assistant", "Dockerfile"))) {
    return sourceTreeRoot;
  }

  // Walk up from the compiled binary's location. When the CLI is bundled
  // inside the macOS app (e.g. .../dist/Cadet.app/Contents/MacOS/cadet-cli),
  // the binary still lives inside the repo tree, so walking up will
  // eventually reach the repo root.
  const execRoot = walkUpForRepoRoot(dirname(process.execPath));
  if (execRoot) {
    return execRoot;
  }

  // Check the app bundle's Resources directory. Debug DMG builds bundle
  // Dockerfiles at Contents/Resources/dockerfiles/{assistant,gateway,...}/Dockerfile.
  // The CLI binary lives at Contents/MacOS/cadet-cli, so Resources is at
  // ../Resources relative to the binary.
  const bundledRoot = join(
    dirname(process.execPath),
    "..",
    "Resources",
    "dockerfiles",
  );
  if (existsSync(join(bundledRoot, "assistant", "Dockerfile"))) {
    return bundledRoot;
  }

  // Walk up from cwd as a final fallback
  const cwdRoot = walkUpForRepoRoot(process.cwd());
  if (cwdRoot) {
    return cwdRoot;
  }

  throw new Error(
    "Could not find repository root containing assistant/Dockerfile. " +
      "Run this command from within the mycadet repository.",
  );
}

interface ServiceImageConfig {
  context: string;
  dockerfile: string;
  tag: string;
}

async function buildImage(config: ServiceImageConfig): Promise<void> {
  await exec(
    "docker",
    ["build", "-f", config.dockerfile, "-t", config.tag, "."],
    { cwd: config.context },
  );
}

function serviceImageConfigs(
  repoRoot: string,
  imageTags: Record<ServiceName, string>,
): Record<ServiceName, ServiceImageConfig> {
  return {
    assistant: {
      context: repoRoot,
      dockerfile: "assistant/Dockerfile",
      tag: imageTags.assistant,
    },
    "credential-executor": {
      context: repoRoot,
      dockerfile: "credential-executor/Dockerfile",
      tag: imageTags["credential-executor"],
    },
    gateway: {
      context: repoRoot,
      dockerfile: "gateway/Dockerfile",
      tag: imageTags.gateway,
    },
  };
}

async function buildAllImages(
  repoRoot: string,
  imageTags: Record<ServiceName, string>,
  log: (msg: string) => void,
): Promise<void> {
  const configs = serviceImageConfigs(repoRoot, imageTags);
  log("🔨 Building all images in parallel...");
  await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      await buildImage(config);
      log(`✅ ${name} built`);
    }),
  );
}

/** The order in which services must be started. */
export const SERVICE_START_ORDER: ServiceName[] = [
  "assistant",
  "gateway",
  "credential-executor",
];

/** Start all three containers in dependency order. */
export async function startContainers(
  opts: {
    createOnly?: boolean;
    bootstrapSecret?: string;
    cesServiceToken?: string;
    extraAssistantEnv?: Record<string, string>;
    extraGatewayEnv?: Record<string, string>;
    gatewayPort: number;
    imageTags: Record<ServiceName, string>;
    instanceName: string;
    res: ReturnType<typeof dockerResourceNames>;
    netnsContainer?: string;
    assistantCaCertPath?: string;
  },
  log: (msg: string) => void,
): Promise<void> {
  const runArgs = buildServiceRunArgs({
    ...opts,
    avatarDevicePath: resolveAvatarDevicePath(),
  });
  for (const service of SERVICE_START_ORDER) {
    const args = runArgs[service]();
    if (opts.createOnly) {
      args[0] = "create";
      args.splice(args.indexOf("-d"), 1);
    }
    log(`${opts.createOnly ? "Creating" : "Starting"} ${service} container...`);
    await exec("docker", args);
  }
}

/** Stop and remove all three containers (ignoring errors). */
export async function stopContainers(
  res: ReturnType<typeof dockerResourceNames>,
): Promise<void> {
  await removeContainer(res.cesContainer);
  await removeContainer(res.gatewayContainer);
  await removeContainer(res.assistantContainer);
}

/** Stop containers without removing them (preserves state for `docker start`). */
export async function sleepContainers(
  res: ReturnType<typeof dockerResourceNames>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  for (const container of [
    res.assistantContainer,
    res.gatewayContainer,
    res.cesContainer,
  ]) {
    try {
      const status = await execOutput("docker", [
        "inspect",
        "--format",
        "{{.State.Status}}",
        container,
      ]);
      if (status === "exited" || status === "created") continue;
      if (status !== "running")
        throw new Error(`${container} is ${status}; cannot stop gracefully.`);
      await exec("docker", ["kill", "--signal=SIGTERM", container]);
      const deadline = Date.now() + (options.timeoutMs ?? 60_000);
      while (
        (await execOutput("docker", [
          "inspect",
          "--format",
          "{{.State.Running}}",
          container,
        ])) === "true"
      ) {
        if (Date.now() >= deadline)
          throw new Error(`${container} did not stop gracefully.`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.toLowerCase() : String(err);
      if (msg.includes("no such container") || msg.includes("is not running")) {
        // container doesn't exist or already stopped — expected, skip
        continue;
      }
      throw err;
    }
  }
}

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
      bootstrapSecret: loadGuardianBootstrapSecret(entry.assistantId),
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
 * Ensure a Docker daemon is reachable before waking an instance's containers
 * (macOS only — on Linux the daemon runs natively).
 *
 * If a daemon is already reachable, reuse it and return: `hatch` created the
 * containers under whatever `docker context` was active at the time (Docker
 * Desktop, an already-running Colima, a remote context, …), and `docker start`
 * targets the active context. Unconditionally starting Colima would switch the
 * active context to `colima` and point `docker start` at a VM that never held
 * those containers — so Colima is only started as a fallback when no daemon is
 * reachable at all (the toolchain `hatch` installs on macOS when Docker Desktop
 * isn't present). This mirrors {@link ensureDockerInstalled}, which likewise
 * only starts Colima when `docker info` fails.
 *
 * `execFn` is injectable so unit tests can drive the probe outcomes without a
 * real Docker/Colima toolchain; production callers use the real {@link exec}.
 * Assumes the toolchain is already installed (handled during hatch).
 */
export async function ensureDockerDaemonRunning(
  execFn: typeof exec = exec,
  opts: { settleTimeoutMs?: number } = {},
): Promise<void> {
  ensureLocalBinOnPath();

  // A reachable daemon — Docker Desktop, a running Colima, or any other active
  // context — is exactly what hatch used. Reuse it rather than forcing Colima.
  try {
    await execFn("docker", ["info"]);
    return;
  } catch {
    // No daemon reachable — fall through to the Colima fallback below.
  }

  // Deliberately no `colima status` probe: it trusts Colima's own state file,
  // which can be stale (zombie VM) — daemon reachability is the oracle.
  console.log("🚀 Docker daemon not running. Starting Colima...");
  await startColimaAndAwaitDaemon(execFn, console.log, opts);
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
export function collectWatchTargets(repoRoot: string): {
  dirs: string[];
  files: string[];
} {
  const packagesDir = join(repoRoot, "packages");
  const packageRoots = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(packagesDir, entry.name))
    : [];

  const serviceRoots = [
    join(repoRoot, "assistant"),
    join(repoRoot, "credential-executor"),
    join(repoRoot, "gateway"),
    ...packageRoots,
  ];

  const dirs: string[] = [];
  const files: string[] = [];
  for (const root of serviceRoots) {
    const srcDir = join(root, "src");
    if (existsSync(srcDir)) dirs.push(srcDir);
    for (const name of ["package.json", "Dockerfile"]) {
      const file = join(root, name);
      if (existsSync(file)) files.push(file);
    }
  }
  return { dirs, files };
}

/**
 * Determine which services are affected by a changed file path relative
 * to the repository root.
 */
function affectedServices(
  filePath: string,
  repoRoot: string,
): Set<ServiceName> {
  const rel = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length + 1)
    : filePath;

  const affected = new Set<ServiceName>();

  if (rel.startsWith("assistant/")) {
    affected.add("assistant");
  }
  if (rel.startsWith("credential-executor/")) {
    affected.add("credential-executor");
  }
  if (rel.startsWith("gateway/")) {
    affected.add("gateway");
  }
  // Shared packages affect both assistant and credential-executor
  if (rel.startsWith("packages/")) {
    affected.add("assistant");
    affected.add("credential-executor");
  }

  return affected;
}

/**
 * Watch for source changes across the assistant, gateway, credential-executor,
 * and packages services — scoped to each service's `src/` tree, `package.json`,
 * and `Dockerfile` (see `collectWatchTargets`). When changes are detected,
 * rebuild the affected images and restart their containers.
 */
function startFileWatcher(opts: {
  bootstrapSecret?: string;
  cesServiceToken?: string;
  extraAssistantEnv?: Record<string, string>;
  extraGatewayEnv?: Record<string, string>;
  gatewayPort: number;
  imageTags: Record<ServiceName, string>;
  instanceName: string;
  repoRoot: string;
  res: ReturnType<typeof dockerResourceNames>;
  netnsContainer?: string;
  assistantCaCertPath?: string;
}): () => void {
  const { gatewayPort, imageTags, instanceName, repoRoot, res } = opts;

  const { dirs: watchDirs, files: watchFiles } = collectWatchTargets(repoRoot);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingServices = new Set<ServiceName>();
  let rebuilding = false;

  const configs = serviceImageConfigs(repoRoot, imageTags);
  const runArgs = buildServiceRunArgs({
    bootstrapSecret: opts.bootstrapSecret,
    cesServiceToken: opts.cesServiceToken,
    extraAssistantEnv: opts.extraAssistantEnv,
    extraGatewayEnv: opts.extraGatewayEnv,
    gatewayPort,
    imageTags,
    instanceName,
    res,
    avatarDevicePath: resolveAvatarDevicePath(),
    netnsContainer: opts.netnsContainer,
    assistantCaCertPath: opts.assistantCaCertPath,
  });
  const containerForService: Record<ServiceName, string> = {
    assistant: res.assistantContainer,
    "credential-executor": res.cesContainer,
    gateway: res.gatewayContainer,
  };

  async function rebuildAndRestart(): Promise<void> {
    if (rebuilding) return;
    rebuilding = true;

    const services = pendingServices;
    pendingServices = new Set();

    // Gateway and CES share the assistant's network namespace. If the
    // assistant container is removed and recreated, the shared namespace
    // is destroyed and the other two lose connectivity. Cascade the
    // restart to all three services in that case.
    if (services.has("assistant")) {
      services.add("gateway");
      services.add("credential-executor");
    }

    const serviceNames = [...services].join(", ");
    console.log(`\n🔄 Changes detected — rebuilding: ${serviceNames}`);

    try {
      await Promise.all(
        [...services].map(async (service) => {
          console.log(`🔨 Building ${service}...`);
          await buildImage(configs[service]);
          console.log(`✅ ${service} built`);
        }),
      );

      // Restart in dependency order (assistant first) so the network
      // namespace owner is up before dependents try to attach.
      for (const service of SERVICE_START_ORDER) {
        if (!services.has(service)) continue;
        const container = containerForService[service];
        console.log(`🔄 Restarting ${container}...`);
        await removeContainer(container);
        await exec("docker", runArgs[service]());
      }

      console.log("✅ Rebuild complete — watching for changes...\n");
    } catch (err) {
      console.error(
        `❌ Rebuild failed: ${err instanceof Error ? err.message : err}`,
      );
      console.log("   Watching for changes...\n");
    } finally {
      rebuilding = false;
      if (pendingServices.size > 0) {
        rebuildAndRestart();
      }
    }
  }

  const watchers: ReturnType<typeof fsWatch>[] = [];

  function onChange(fullPath: string): void {
    const services = affectedServices(fullPath, repoRoot);
    if (services.size === 0) return;

    for (const s of services) {
      pendingServices.add(s);
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      rebuildAndRestart();
    }, 500);
  }

  for (const dir of watchDirs) {
    const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.includes("node_modules") || filename.includes(".env")) {
        return;
      }
      onChange(join(dir, filename));
    });
    // fs.watch surfaces transient errors (e.g. an unreadable entry) as an
    // `error` event, which would otherwise crash the process. Log and keep
    // the remaining watchers running.
    watcher.on("error", (err) => {
      console.error(
        `⚠️  File watcher error for ${dir}: ${err instanceof Error ? err.message : err}`,
      );
    });
    watchers.push(watcher);
  }

  for (const file of watchFiles) {
    const watcher = fsWatch(file, () => onChange(file));
    watcher.on("error", (err) => {
      console.error(
        `⚠️  File watcher error for ${file}: ${err instanceof Error ? err.message : err}`,
      );
    });
    watchers.push(watcher);
  }

  console.log("👀 Watching for file changes in:");
  console.log("   <service>/src, <service>/package.json, <service>/Dockerfile");
  console.log("   for assistant/, gateway/, credential-executor/, packages/*");
  console.log("");

  return () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}

export async function hatchDocker(params: HatchDockerParams): Promise<void> {
  const { name = null, configValues = {} } = params;
  let watch = params.watch ?? false;

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
    await ensureDockerInstalled();

    const instanceName = generateInstanceName(name);
    // Resolve the gateway's host port. When joining an externally-owned
    // network namespace, the owner has already published the gateway port,
    // so the caller — not hatch — owns port allocation; use the supplied
    // port verbatim. Otherwise resolve it dynamically: the env-default
    // (production 7830 / non-prod overrides) is just the *preferred*
    // starting point — if it's taken by another local assistant, eval run,
    // or unrelated process, we walk upward until we find a free port, so
    // concurrent instances don't collide on a docker bind error.
    let gatewayPort: number;
    if (params.netnsContainer) {
      if (params.gatewayPort === undefined) {
        throw new Error(
          "hatchDocker: gatewayPort is required when netnsContainer is set (the namespace owner publishes the port before hatch runs)",
        );
      }
      gatewayPort = params.gatewayPort;
    } else {
      const preferredGatewayPort = getDefaultPorts().gateway;
      gatewayPort = await findOpenPort(preferredGatewayPort);
      if (gatewayPort !== preferredGatewayPort) {
        log(
          `Preferred gateway port ${preferredGatewayPort} is in use; allocated ${gatewayPort} for this instance.`,
        );
      }
    }

    // Allocate the assistant HTTP API host port. Same dynamic-allocation
    // strategy as the gateway port: the env-default (production 7821 /
    // non-prod overrides) is the *preferred* starting point, and we walk
    // upward until we find a free port. Without this, two concurrent
    // `cadet hatch --remote docker` on the same host collide on a fixed
    // 7821 bind ("port is already allocated"). Unused when netnsContainer
    // is set — no host ports are published in that mode.
    let assistantPort: number;
    if (params.netnsContainer) {
      assistantPort = ASSISTANT_INTERNAL_PORT;
    } else {
      const preferredAssistantPort = getDefaultPorts().daemon;
      assistantPort = await findOpenPort(preferredAssistantPort, {
        exclude: [gatewayPort],
      });
      if (assistantPort !== preferredAssistantPort) {
        log(
          `Preferred assistant port ${preferredAssistantPort} is in use; allocated ${assistantPort} for this instance.`,
        );
      }
    }

    const imageTags: Record<ServiceName, string> = {
      assistant: "",
      "credential-executor": "",
      gateway: "",
    };

    const sourcePath =
      typeof params.sourcePath === "string" && params.sourcePath.length > 0
        ? params.sourcePath
        : null;
    const buildFromSource = sourcePath !== null;
    let repoRoot: string | undefined;
    let fullSourceTreeAvailable = false;

    if (watch || buildFromSource) {
      // When --source <path> is supplied, trust the caller and use it
      // directly. Otherwise (the --watch case) walk up from known locations
      // to find the repo root.
      repoRoot = sourcePath ? resolve(sourcePath) : findRepoRoot();

      // When running from a packaged .app bundle, the Dockerfiles are
      // present (so findRepoRoot succeeds) but the full source tree is
      // not — we can't build images locally. Fall back to pulling
      // pre-built images instead.
      fullSourceTreeAvailable = hasFullSourceTree(repoRoot);
      if (!fullSourceTreeAvailable) {
        log(
          "⚠️  Dockerfiles found but no source tree — falling back to image pull",
        );
        repoRoot = undefined;
      }
    }

    const mode = resolveDockerHatchMode({
      watch,
      buildFromSource,
      fullSourceTreeAvailable,
    });
    // Honour the resolved mode for the rest of the flow.
    watch = mode.watcher;

    if (mode.build && repoRoot) {
      const localTag = `local-${instanceName}`;
      imageTags.assistant = `mycadet:${localTag}`;
      imageTags.gateway = `cadet-gateway:${localTag}`;
      imageTags["credential-executor"] =
        `cadet-credential-executor:${localTag}`;

      log(`🥚 Hatching Docker assistant: ${instanceName}`);
      log(
        `   Mode: ${mode.watcher ? "development (watch)" : "build-from-source"}`,
      );
      log(`   Repo: ${repoRoot}`);
      log(`   Images (local build):`);
      log(`     assistant:            ${imageTags.assistant}`);
      log(`     gateway:              ${imageTags.gateway}`);
      log(`     credential-executor:  ${imageTags["credential-executor"]}`);
      log("");

      await buildAllImages(repoRoot, imageTags, log);
      log("✅ Docker images built");
    }

    if (!mode.build || !repoRoot) {

      // Allow explicit image overrides via environment variables.
      // When all three are set, skip version-based resolution entirely.
      const envAssistant = process.env.CADET_ASSISTANT_IMAGE;
      const envGateway = process.env.CADET_GATEWAY_IMAGE;
      const envCredentialExecutor = process.env.CADET_CREDENTIAL_EXECUTOR_IMAGE;

      let imageSource: string;

      if (envAssistant && envGateway && envCredentialExecutor) {
        imageTags.assistant = envAssistant;
        imageTags.gateway = envGateway;
        imageTags["credential-executor"] = envCredentialExecutor;
        imageSource = "env override";
        log("Using image overrides from environment variables");
      } else {
        log(`🔍 Resolving image references from CLI version...`);
        const resolved = resolveOwnImageRefs(cliPkg.version);
        imageTags.assistant = resolved.assistant;
        imageTags.gateway = resolved.gateway;
        imageTags["credential-executor"] = resolved["credential-executor"];
        imageSource = "dockerhub";
      }

      log(`🥚 Hatching Docker assistant: ${instanceName}`);
      log(`   Images (${imageSource}):`);
      log(`     assistant:            ${imageTags.assistant}`);
      log(`     gateway:              ${imageTags.gateway}`);
      log(`     credential-executor:  ${imageTags["credential-executor"]}`);
      log("");

      // Per-ref branching: local-build refs need the image-loader; external
      // registry refs get a normal `docker pull`. The two transports compose
      // cleanly — a release can mix different sources for different images.
      log("📦 Acquiring Docker images...");
      for (const service of [
        "assistant",
        "gateway",
        "credential-executor",
      ] as const) {
        const ref = imageTags[service];
        if (isLocalBuildRef(ref)) {
          log(`   ↪ loading ${ref} via host image-loader`);
          await loadImageViaHost(HOST_IMAGE_LOADER_URL, ref, log);
        } else {
          log(`   ↪ pulling ${ref}`);
          const MAX_PULL_RETRIES = 3;
          for (let attempt = 1; attempt <= MAX_PULL_RETRIES; attempt++) {
            try {
              await pullImage(ref, log);
              break;
            } catch (err) {
              if (attempt === MAX_PULL_RETRIES) throw err;
              const delaySec = 2 ** attempt;
              log(
                `   ⚠ pull failed (attempt ${attempt}/${MAX_PULL_RETRIES}), retrying in ${delaySec}s...`,
              );
              await new Promise((r) => setTimeout(r, delaySec * 1000));
            }
          }
        }
      }
      log(green("✅ Docker images acquired", process.stdout));
    }

    const res = dockerResourceNames(instanceName);
    // When joining an externally-owned network namespace, the owner already
    // provides the network stack — creating a per-instance network here would
    // be unused and leak on teardown.
    if (params.netnsContainer) {
      log("📁 Joining existing network namespace; creating volumes...");
    } else {
      log("📁 Creating network and volumes...");
      await exec("docker", ["network", "create", res.network]);
    }
    await exec("docker", ["volume", "create", res.socketVolume]);
    await exec("docker", ["volume", "create", res.assistantIpcVolume]);
    await exec("docker", ["volume", "create", res.gatewayIpcVolume]);
    await exec("docker", ["volume", "create", res.workspaceVolume]);
    await exec("docker", ["volume", "create", res.cesSecurityVolume]);
    await exec("docker", ["volume", "create", res.gatewaySecurityVolume]);

    // Set volume ownership so non-root containers (UID 1001) can write.
    await exec("docker", [
      "run",
      "--rm",
      "-v",
      `${res.workspaceVolume}:/workspace`,
      "-v",
      `${res.assistantIpcVolume}:/run/assistant-ipc`,
      "-v",
      `${res.gatewayIpcVolume}:/run/gateway-ipc`,
      "busybox",
      "sh",
      "-c",
      "chown 1001:1001 /workspace /run/assistant-ipc /run/gateway-ipc",
    ]);

    // Stage the BYOK default-workspace-config overlay *inside* the workspace
    // volume so the daemon's startup loader can consume it. The loader
    // (`mergeDefaultWorkspaceConfig` in assistant/src/config/loader.ts) does:
    //   1. JSON.parse + deep-merge into the workspace's config.json.
    //   2. `renameSync(defaultConfigPath, <workspace>/default-config.json)`
    //      to mark the overlay consumed so subsequent restarts skip it.
    //
    // The rename must be same-filesystem. Bind-mounting the host file into
    // `/tmp/...` (the pre-#32025 design) crossed filesystems and silently
    // failed with EXDEV, so every `docker start` re-applied the overlay.
    // Staging into the workspace volume keeps the rename in-place.
    //
    // Streaming the JSON via stdin (instead of bind-mounting the host file
    // into the staging container) sidesteps macOS Colima's virtiofs share,
    // which doesn't expose `/var/folders/...` (where `os.tmpdir()` resolves
    // on macOS) and would otherwise materialize an empty directory at the
    // bind-mount target.
    //
    // @deprecated stopgap. Replacement direction is one of:
    //   1. Post-hatch API calls (POST /v1/secrets + a small endpoint that
    //      returns canonical inference-profile templates).
    //   2. Move inference-profile seeds out of workspace config and into
    //      Assistant code, eliminating the overlay entirely.
    // See `cli/src/lib/config-utils.ts` JSDoc for context.
    const hatchConfigValues = buildHatchConfigValues(configValues, provider);
    const hostOverlayPath = writeInitialConfig(hatchConfigValues);
    const stagedOverlayInContainer = "/workspace/.default-config-overlay.json";
    const extraAssistantEnv: Record<string, string> = {};
    if (hostOverlayPath) {
      await execWithStdin(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "-v",
          `${res.workspaceVolume}:/workspace`,
          "busybox",
          "sh",
          "-c",
          `cat > ${stagedOverlayInContainer} && chown 1001:1001 ${stagedOverlayInContainer}`,
        ],
        readFileSync(hostOverlayPath, "utf-8"),
      );
      extraAssistantEnv.CADET_DEFAULT_WORKSPACE_CONFIG_PATH =
        stagedOverlayInContainer;
    }

    const cesServiceToken = randomBytes(32).toString("hex");

    // When launched by a remote hatch startup script, the env var
    // GUARDIAN_BOOTSTRAP_SECRET is already set with the laptop's secret.
    // Generate a new secret for the local docker hatch caller and append
    // it so the gateway receives a comma-separated list of all expected
    // bootstrap secrets.
    const ownSecret = randomBytes(32).toString("hex");
    saveGuardianBootstrapSecret(instanceName, ownSecret);
    const preExisting = process.env.GUARDIAN_BOOTSTRAP_SECRET;
    const bootstrapSecret = preExisting
      ? `${preExisting},${ownSecret}`
      : ownSecret;
    const hostDeviceId = getOrCreateHostDeviceId();
    extraAssistantEnv.CADET_DEVICE_ID = hostDeviceId;
    // Forward the migration URL allowlists so a daemon inside the container
    // can PUT/GET teleport bundles against a local (non-GCS) platform.
    // Pass-through only: unset in normal use, preserving the strict
    // GCS-only validator default. A containerized daemon reaches the host
    // via host.docker.internal, so that is the value to export when
    // teleporting docker assistants against a local platform.
    for (const key of [
      "CADET_MIGRATION_EXPORT_ALLOWED_HOSTS",
      "CADET_MIGRATION_IMPORT_ALLOWED_HOSTS",
    ] as const) {
      const value = process.env[key];
      if (value) {
        extraAssistantEnv[key] = value;
      }
    }
    const extraGatewayEnv = {
      CADET_DEVICE_ID: hostDeviceId,
    };
    const gatewayUrl = `http://localhost:${gatewayPort}`;
    const dockerEntry: LockfileAssistant = {
      assistantId: instanceName,
      port: gatewayPort,
      daemonPort: assistantPort,
      cloud: "docker",
      hatchedAt: new Date().toISOString(),
      containerInfo: {
        assistantImage: imageTags.assistant,
        gatewayImage: imageTags.gateway,
        cesImage: imageTags["credential-executor"],
      },
    };
    if (params.initialArchive) {
      saveLockfileAssistant(dockerEntry);
    }
    await startContainers(
      {
        createOnly: !!params.initialArchive,
        bootstrapSecret,
        cesServiceToken,
        extraAssistantEnv,
        extraGatewayEnv,
        gatewayPort,
        imageTags,
        instanceName,
        res,
        netnsContainer: params.netnsContainer,
        assistantCaCertPath: params.assistantCaCertPath,
      },
      log,
    );
    const containersUpAt = Date.now();
    saveLockfileAssistant(dockerEntry);
    setActiveAssistant(instanceName);

    if (params.initialArchive) {
      const { initializeRootArchive, DockerRootStorage } =
        await import("../root-backup.js");
      await initializeRootArchive(dockerEntry, params.initialArchive);
      const storage = new DockerRootStorage(dockerEntry);
      storage.initialRunning = new Set(Object.values(storage.containers));
      await storage.resume();
    }
    // Hatch always detaches; only watch mode keeps the log stream attached.
    const waitDetached = !watch;
    const { ready, guardianAccessToken, notReadyReason } = params.initialArchive
      ? {
          ready: true,
          guardianAccessToken: undefined,
          notReadyReason: undefined,
        }
      : await waitForGatewayAndLease({
          entry: dockerEntry,
          containerName: res.assistantContainer,
          detached: waitDetached,
          instanceName,
          logFd,
          containersUpAt,
        });

    if (!ready && !(watch && repoRoot)) {
      throw new Error(
        notReadyReason === "migrations_failed"
          ? "Assistant database migrations failed — the container is running but DB-backed routes are unavailable; check its logs and restore a backup or retry the migration"
          : "Timed out waiting for assistant to become ready",
      );
    }

    if (ready) {
      const providerSetupAction = resolveDockerProviderCredentialSetupAction({
        provider,
        guardianAccessToken,
        detached: waitDetached,
        precollectedKey: precollectedApiKey,
      });

      if (providerSetupAction === "defer" && provider !== null) {
        log(
          `Provider credential setup deferred in detached mode.\n` +
            `Run \`cadet setup --provider ${provider}\` after the assistant is ready.`,
        );
      } else if (providerSetupAction === "missing-token" && provider !== null) {
        log(
          yellow(
            `⚠️  Provider credential setup skipped because the guardian token was not leased.\n` +
              `   The assistant is still hatched. Run \`cadet setup --provider ${provider}\` after fixing the connection.`,
            process.stdout,
          ),
        );
      } else if (
        providerSetupAction === "configure" &&
        provider !== undefined
      ) {
        await configureHatchProviderApiKey({
          gatewayUrl,
          provider,
          bearerToken: guardianAccessToken,
          env: process.env,
          precollectedKey: precollectedApiKey,
          log,
        });
      }
      logHatchNextSteps(log);
    }

    if (watch && repoRoot) {
      const watching: LockfileAssistant = {
        ...dockerEntry,
        watcherPid: process.pid,
      };
      saveLockfileAssistant(watching);
      const stopWatcher = startFileWatcher({
        bootstrapSecret,
        cesServiceToken,
        extraAssistantEnv,
        extraGatewayEnv,
        gatewayPort,
        imageTags,
        instanceName,
        repoRoot,
        res,
        netnsContainer: params.netnsContainer,
        assistantCaCertPath: params.assistantCaCertPath,
      });

      await new Promise<void>((resolve) => {
        const cleanup = async () => {
          log("\n🛑 Shutting down...");
          stopWatcher();
          await stopContainers(res);
          const unwatched: LockfileAssistant = {
            ...dockerEntry,
            watcherPid: undefined,
          };
          saveLockfileAssistant(unwatched);
          log("✅ Docker instance stopped.");
          resolve();
        };

        // SIGINT (Ctrl+C): full cleanup including stopping containers.
        process.on("SIGINT", () => void cleanup());

        // SIGTERM (from `cadet retire`): exit quickly — the caller
        // handles container teardown, so we only need to close the
        // file watchers and let the process terminate.
        process.on("SIGTERM", () => {
          stopWatcher();
          saveLockfileAssistant({
            ...dockerEntry,
            watcherPid: undefined,
          });
          resolve();
        });
      });
    }
  } finally {
    closeLogFile(logFd);
    logFd = "ignore";
  }
}

/**
 * In detached mode, print instance details and return immediately.
 * Otherwise, poll the gateway health check until it responds, then
 * lease a guardian token.
 */
async function waitForGatewayAndLease(opts: {
  entry: LockfileAssistant;
  containerName: string;
  detached: boolean;
  instanceName: string;
  logFd: number | "ignore";
  containersUpAt: number;
}): Promise<{
  ready: boolean;
  guardianAccessToken?: string;
  /** Present when readiness was not reached because migrations terminally
   * failed (returned in seconds, unlike an actual timeout). */
  notReadyReason?: "migrations_failed";
}> {
  const {
    entry,
    containerName,
    detached,
    instanceName,
    logFd,
    containersUpAt,
  } = opts;
  const gatewayUrl = getGatewayUrl(entry);

  const log = (msg: string): void => {
    console.log(msg);
    writeToLogFile(logFd, `${new Date().toISOString()} ${msg}\n`);
  };

  if (detached) {
    // Lease a guardian token BEFORE declaring the assistant hatched so the
    // banner means `cadet ps`, `cadet exec`, and other CLI commands can
    // already authenticate. Skip the /readyz readiness poll (the caller
    // asked to detach and not block) but retry the lease silently since
    // the gateway may need a moment to accept connections after the
    // container starts; only a final failure surfaces to the user.
    const leaseDeadline = containersUpAt + DOCKER_READY_TIMEOUT_MS;
    let guardianAccessToken: string | undefined;
    while (Date.now() < leaseDeadline) {
      try {
        const tokenData = await leaseGuardianToken(entry);
        guardianAccessToken = tokenData.accessToken;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!guardianAccessToken) {
      log(
        yellow(
          `⚠️  Guardian token lease failed after ${DOCKER_READY_TIMEOUT_MS / 1000}s.\n` +
            `   The assistant is running but CLI commands (cadet ps, cadet exec) will not authenticate.\n` +
            `   Re-hatch or run \`cadet setup\` to recover.`,
          process.stdout,
        ),
      );
    }

    log(`\n${green("✅ Docker assistant hatched!", process.stdout)}\n`);
    log("Instance details:");
    printInstanceDetails(
      {
        name: instanceName,
        runtime: gatewayUrl,
        container: containerName,
      },
      log,
    );
    log("");
    return { ready: true, guardianAccessToken };
  }

  log(`  Container: ${containerName}`);
  log(`  Runtime: ${gatewayUrl}`);
  log("");
  log("Waiting for assistant to become ready...");

  const readyUrl = `${gatewayUrl}/readyz`;
  const start = containersUpAt;
  let ready = false;
  let migrationsFailed = false;

  // Readiness is classified from the /readyz BODY: the assistant returns 200
  // with `ready: false` while DB migrations run (the k8s keep-the-pod
  // contract), so `resp.ok` alone would declare readiness mid-migration and
  // the guardian token lease below would burn its shared budget against the
  // gateway's still-closed traffic gate.
  while (Date.now() - start < DOCKER_READY_TIMEOUT_MS) {
    try {
      const resp = await loopbackSafeFetch(readyUrl, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json().catch(() => null)) as {
        status?: string;
        upstream?: number;
      } | null;
      const readiness = classifyReadyzResponse(resp.ok, body);
      if (readiness === "ready") {
        ready = true;
        break;
      }
      if (readiness === "failed") {
        migrationsFailed = true;
        break;
      }
      const parts = [body?.status].filter(Boolean);
      if (body?.upstream != null) parts.push(`upstream=${body.upstream}`);
      const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
      log(`Readiness check: ${resp.status}${detail} (retrying...)`);
    } catch {
      // Connection refused / timeout — not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    log("");
    if (migrationsFailed) {
      log(`   \u26a0\ufe0f  Assistant database migrations FAILED.`);
    } else {
      log(`   \u26a0\ufe0f  Timed out waiting for assistant to become ready.`);
    }
    log(`   The container is still running.`);
    log(`   Check logs with: docker logs -f ${containerName}`);
    log("");
    return {
      ready: false,
      ...(migrationsFailed
        ? { notReadyReason: "migrations_failed" as const }
        : {}),
    };
  }

  const readyAt = Date.now();
  const containersUpToReadyMs = readyAt - start;
  const elapsedSec = (containersUpToReadyMs / 1000).toFixed(1);
  log(`Assistant ready after ${elapsedSec}s`);
  console.info(
    `[cadet-hatch-timing] ${JSON.stringify({
      containers_up_to_ready_ms: containersUpToReadyMs,
      instance: instanceName,
    })}`,
  );

  // Lease guardian token. The /readyz check confirms both gateway and
  // assistant are reachable. Retry with backoff in case there is a brief
  // window where readiness passes but the guardian endpoint is not yet ready.
  const leaseStart = Date.now();
  const leaseDeadline = start + DOCKER_READY_TIMEOUT_MS;
  let leaseSuccess = false;
  let lastLeaseError: string | undefined;
  let guardianAccessToken: string | undefined;

  while (Date.now() < leaseDeadline) {
    try {
      const tokenData = await leaseGuardianToken(entry);
      guardianAccessToken = tokenData.accessToken;
      leaseSuccess = true;
      break;
    } catch (err) {
      lastLeaseError =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!leaseSuccess) {
    log(
      yellow(
        `\u26a0\ufe0f  Guardian token lease: FAILED after ${(
          (Date.now() - leaseStart) /
          1000
        ).toFixed(1)}s — ${lastLeaseError ?? "unknown error"}`,
        process.stdout,
      ),
    );
  }

  log("");
  log(green(`\u2705 Docker containers are up and running!`, process.stdout));
  log(`   Name: ${instanceName}`);
  log(`   Runtime: ${gatewayUrl}`);
  log("");
  return { ready: true, guardianAccessToken };
}

/**
 * Mint (and approve) a remote-web pairing challenge inside the gateway
 * container — the docker topology's `gateway pairing mint`. Returns the
 * command's stdout; its last line is the challenge JSON.
 */
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
