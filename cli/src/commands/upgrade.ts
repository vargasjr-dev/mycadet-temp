import { upgradeDocker } from "../lib/remotes/docker.js";
import {
  getGatewayUrl,
  isDockerEntry,
  isLocalEntry,
} from "@mycadet/local-mode/contract";
import { isCloudHome } from "../lib/cloud-values.js";
import { spawnSync } from "child_process";

import cliPkg from "../../package.json";

import { type LockfileAssistant } from "@mycadet/local-mode/contract";
import { findAssistantByName } from "../lib/assistant-config";
import { type LocalAssistant } from "@mycadet/local-mode/contract";
import {
  cliCommand,
  cloudAuthHeaders,
  formatAssistantLookupError,
  getActiveAssistant,
  getCloudUrl,
  loadAllAssistants,
  lookupAssistantByIdentifier,
  loopbackSafeFetch,
  readCloudToken,
  saveLockfileAssistant,
} from "@mycadet/local-mode";
import { fetchLatestVersion, fetchReleases } from "../lib/cloud-releases";
import {
  fetchAssistantDetail,
  fetchUpgradeInProgress,
} from "../lib/cloud-client";
import { checkCloudHealth } from "../lib/health-check.js";
import {
  evaluateUpgradePoll,
  resolveUpgradeTarget,
} from "../lib/upgrade-preflight.js";
import {
  createBackup,
  pruneOldBackups,
  restoreBackup,
} from "../lib/backup-ops.js";
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  buildProgressEvent,
  buildStartingEvent,
  buildUpgradeCommitMessage,
  commitWorkspaceViaGateway,
  UPGRADE_PROGRESS,
  waitForReady,
} from "../lib/upgrade-lifecycle.js";
import { emitCliError, categorizeUpgradeError } from "../lib/cli-error.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { isLocalVersion } from "@mycadet/shared/version";
import {
  compareVersions,
  stripVersionPrefix,
  versionsEqual,
} from "../lib/version-compat.js";
import { fetchCurrentVersion } from "@mycadet/local-mode";
import {
  ensureLocalRuntime,
  generateLocalSecret,
  startCes,
  startGateway,
  startLocalDaemon,
} from "@mycadet/local-mode";
import { stopLocalProcesses } from "../lib/remotes/local.js";
import { restoreAppServerAndAutoTunnel } from "../lib/tunnel.js";
import { leaseGuardianToken } from "../lib/guardian-token.js";

interface UpgradeArgs {
  name: string | null;
  version: string | null;
  latest: boolean;
  prepare: boolean;
  finalize: boolean;
  noWait: boolean;
  force: boolean;
}

// Flags that consume the following argv token as a value, rather than a
// boolean switch. Passed to `parseAssistantTargetArg` so an unquoted
// multi-word display name is not truncated at a flag's value.
const UPGRADE_FLAGS_WITH_VALUES = ["--version"];

function parseArgs(): UpgradeArgs {
  const args = process.argv.slice(3);
  const name = parseAssistantTargetArg(args, UPGRADE_FLAGS_WITH_VALUES) ?? null;
  let version: string | null = null;
  let latest = false;
  let prepare = false;
  let finalize = false;
  let noWait = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: ${cliCommand()} upgrade [<name>] [options]`);
      console.log("");
      console.log("Upgrade an assistant to a newer version.");
      console.log(
        "To roll back to a previous version, use `cadet restore` with a backup.",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>               Name of the assistant to upgrade, defaults to active or only assistant",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --version <version>  Target version to upgrade to, defaults to the CLI version",
      );
      console.log(
        "  --latest             Upgrade to the latest stable release, updating the CLI first if needed",
      );
      console.log(
        "  --prepare            Run pre-upgrade steps only (backup, notify) without swapping versions",
      );
      console.log(
        "  --finalize           Run post-upgrade steps only (broadcast complete, workspace commit)",
      );
      console.log(
        "  --no-wait            Platform assistants only: return after the upgrade request is accepted instead of waiting for completion",
      );
      console.log(
        "  --force              Local/Docker assistants only: reinstall even when already on the target version",
      );
      console.log("");
      console.log("Examples:");
      console.log(
        "  cadet upgrade                              # Upgrade the active assistant to the CLI's version",
      );
      console.log(
        "  cadet upgrade --latest                     # Upgrade CLI + assistant to the latest stable release",
      );
      console.log(
        "  cadet upgrade my-assistant                  # Upgrade a specific assistant by name",
      );
      console.log(
        "  cadet upgrade my-assistant --version v1.2.3 # Upgrade to a specific version",
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
    } else if (arg === "--latest") {
      latest = true;
    } else if (arg === "--prepare") {
      prepare = true;
    } else if (arg === "--finalize") {
      finalize = true;
    } else if (arg === "--no-wait") {
      noWait = true;
    } else if (arg === "--force") {
      force = true;
    } else if (!arg.startsWith("-")) {
      // Positional token, part of a possibly multi-word display name.
      // Collected up front via `parseAssistantTargetArg` above.
    } else {
      console.error(`Error: Unknown option '${arg}'.`);
      emitCliError("UNKNOWN", `Unknown option '${arg}'`);
      process.exit(1);
    }
  }

  if (prepare && finalize) {
    console.error("Error: --prepare and --finalize are mutually exclusive.");
    emitCliError("UNKNOWN", "--prepare and --finalize are mutually exclusive");
    process.exit(1);
  }

  if (latest && version) {
    console.error("Error: --latest and --version are mutually exclusive.");
    emitCliError("UNKNOWN", "--latest and --version are mutually exclusive");
    process.exit(1);
  }

  if (noWait && (prepare || finalize)) {
    console.error(
      "Error: --no-wait cannot be combined with --prepare or --finalize.",
    );
    emitCliError(
      "UNKNOWN",
      "--no-wait cannot be combined with --prepare or --finalize",
    );
    process.exit(1);
  }

  return { name, version, latest, prepare, finalize, noWait, force };
}

/**
 * Resolve which assistant to target for the upgrade command. Priority:
 * 1. Explicit name argument (exact assistant ID wins over a display-name
 *    match; a unique display-name match resolves; an ambiguous display
 *    name is an error listing the matching IDs)
 * 2. Active assistant set via `cadet use`
 * 3. Sole assistant (when exactly one exists)
 */
function resolveTargetAssistant(nameArg: string | null): LockfileAssistant {
  if (nameArg) {
    const result = lookupAssistantByIdentifier(nameArg);
    if (result.status !== "found") {
      const msg = formatAssistantLookupError(nameArg, result);
      console.error(msg);
      emitCliError("ASSISTANT_NOT_FOUND", msg);
      process.exit(1);
    }
    return result.entry;
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

export async function targetVersionFromCli(
  version: string | null,
  cliVersion = cliPkg.version,
  resolveLatestStable: () => Promise<string> = resolveLatestStableTag,
): Promise<string> {
  const targetVersion = version ?? (cliVersion ? `v${cliVersion}` : "latest");
  if (!isLocalVersion(targetVersion)) return targetVersion;

  const latestTag = await resolveLatestStable();
  console.log(
    `   Local build version ${targetVersion} is not published; using latest stable ${latestTag}.\n`,
  );
  return latestTag;
}

async function ensureGuardianTokenAfterLocalUpgrade(
  entry: LockfileAssistant,
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Pairing IS the repair — re-pair mints a fresh device-bound pair for
      // the existing guardian under the loopback presence proof.
      await leaseGuardianToken(entry);
      console.log("   Re-provisioned guardian token.");
      return;
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      } else {
        console.warn(
          `   Guardian token re-provision failed after ${maxAttempts} attempts: ${err}`,
        );
      }
    }
  }
}

async function upgradeLocal(
  entry: LocalAssistant,
  version: string | null,
  force: boolean,
): Promise<void> {
  // The runtime fields the upgrade replaces, snapshotted for the failure
  // path's rollback to the previous install.
  const originalRuntime = {
    runtimeVersion: entry.runtimeVersion,
    runtimeInstallDir: entry.runtimeInstallDir,
  };

  const targetVersion = await targetVersionFromCli(version);
  const adminUrl = `http://127.0.0.1:${entry.port}`;
  const currentVersion = await fetchCurrentVersion(adminUrl);

  if (!currentVersion && targetVersion) {
    console.warn(
      "⚠️  Could not determine current version from health endpoint — skipping version-direction check.\n",
    );
  }
  if (currentVersion && targetVersion) {
    const cmp = compareVersions(targetVersion, currentVersion);
    if (cmp !== null && cmp < 0) {
      const msg = `Cannot upgrade to an older version (${targetVersion} < ${currentVersion}). Use \`cadet restore --from <backup-path> --version ${targetVersion}\` instead.`;
      console.error(msg);
      emitCliError("VERSION_DIRECTION", msg);
      process.exit(1);
    }
  }

  if (currentVersion && versionsEqual(targetVersion, currentVersion)) {
    if (!force) {
      console.log(
        `✅ Already on ${targetVersion}. Nothing to do. Pass --force to reinstall.`,
      );
      return;
    }
    console.log(`🔁 Reinstalling ${targetVersion} with --force...\n`);
  }

  console.log(
    `🔄 Upgrading local assistant '${entry.assistantId}' to ${targetVersion}...\n`,
  );

  await commitWorkspaceViaGateway(
    adminUrl,
    entry.assistantId,
    buildUpgradeCommitMessage({
      action: "upgrade",
      phase: "starting",
      from: currentVersion ?? "unknown",
      to: targetVersion,
      topology: "local",
      assistantId: entry.assistantId,
    }),
  );

  console.log("📢 Notifying connected clients...");
  await broadcastUpgradeEvent(
    adminUrl,
    entry.assistantId,
    buildStartingEvent(targetVersion),
  );
  await new Promise((r) => setTimeout(r, 500));

  await broadcastUpgradeEvent(
    adminUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.BACKING_UP),
  );
  console.log("📦 Creating pre-upgrade backup...");
  const backupPath = await createBackup(entry.assistantId, {
    prefix: `${entry.assistantId}-pre-upgrade`,
    description: `Pre-upgrade snapshot before ${currentVersion ?? "unknown"} → ${targetVersion}`,
  });
  if (backupPath) {
    console.log(`   Backup saved: ${backupPath}\n`);
    pruneOldBackups(entry.assistantId, 3);
  } else {
    console.warn(
      "⚠️  Pre-upgrade backup failed — continuing WITHOUT a backup; this upgrade cannot be rolled back from one.",
    );
  }

  await broadcastUpgradeEvent(
    adminUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.INSTALLING),
  );

  console.log(
    "⬇️  Downloading local runtime packages (assistant, gateway, credential-executor)...",
  );
  const runtimeInstall = ensureLocalRuntime(entry, targetVersion, {
    force,
  });
  entry.runtimeVersion = runtimeInstall.version;
  entry.runtimeInstallDir = runtimeInstall.installDir;
  saveLockfileAssistant(entry);
  const upgradedEntry = entry;
  console.log(`   Runtime installed: ${runtimeInstall.installDir}\n`);

  try {
    console.log("🛑 Stopping local assistant processes...");
    await stopLocalProcesses(upgradedEntry);
    console.log("✅ Local assistant processes stopped\n");

    console.log("🚀 Starting upgraded local assistant...");
    const previousAppVersion = process.env.APP_VERSION;
    process.env.APP_VERSION = stripVersionPrefix(targetVersion);
    try {
      // Bring CES, daemon, and gateway up in parallel, the way the Docker
      // topology starts its sibling processes together. startCes always
      // launches the CES sibling.
      await Promise.all([
        startCes(false, upgradedEntry),
        startLocalDaemon(false, upgradedEntry),
        startGateway(false, upgradedEntry),
      ]);
    } finally {
      if (previousAppVersion === undefined) {
        delete process.env.APP_VERSION;
      } else {
        process.env.APP_VERSION = previousAppVersion;
      }
    }
    await ensureGuardianTokenAfterLocalUpgrade(entry);
    console.log("✅ Local assistant processes started\n");

    await restoreAppServerAndAutoTunnel();

    console.log("Waiting for assistant to become ready...");
    const ready = await waitForReady(adminUrl);
    if (!ready) {
      await broadcastUpgradeEvent(
        adminUrl,
        entry.assistantId,
        buildCompleteEvent(currentVersion ?? "unknown", false),
      );
      const msg = `Upgrade to ${targetVersion} failed: local assistant did not become ready.`;
      console.error(`\n❌ ${msg}`);
      throw new Error(msg);
    }
  } catch (error) {
    console.error(
      "Local upgrade failed; restoring the previous runtime and service roots...",
    );
    await stopLocalProcesses(upgradedEntry);
    entry.runtimeVersion = originalRuntime.runtimeVersion;
    entry.runtimeInstallDir = originalRuntime.runtimeInstallDir;
    saveLockfileAssistant(entry);
    if (backupPath) {
      const restored = await restoreBackup(entry.assistantId, backupPath, {
        resume: false,
      });
      if (!restored)
        throw new Error(
          `Local recovery failed; services remain stopped. Backup: ${backupPath}`,
          { cause: error },
        );
      await Promise.all([
        startCes(false, entry),
        startLocalDaemon(false, entry),
        startGateway(false, entry),
      ]);
      if (!(await waitForReady(adminUrl)))
        throw new Error(
          `Previous local runtime did not recover. Backup: ${backupPath}`,
          { cause: error },
        );
    }
    throw error;
  }

  await broadcastUpgradeEvent(
    adminUrl,
    entry.assistantId,
    buildCompleteEvent(targetVersion, true),
  );

  await commitWorkspaceViaGateway(
    adminUrl,
    entry.assistantId,
    buildUpgradeCommitMessage({
      action: "upgrade",
      phase: "complete",
      from: currentVersion ?? "unknown",
      to: targetVersion,
      topology: "local",
      assistantId: entry.assistantId,
      result: "success",
    }),
  );

  console.log(
    `\n✅ Local assistant '${entry.assistantId}' upgraded to ${targetVersion}.`,
  );
}

interface UpgradeApiResponse {
  detail: string;
  version: string | null;
}

const PLATFORM_POLL_INTERVAL_MS = 3_000;
const PLATFORM_POLL_HEARTBEAT_MS = 30_000;
const PLATFORM_HEALTH_CONFIRM_TIMEOUT_MS = 120_000;
const PLATFORM_HEALTH_CONFIRM_INTERVAL_MS = 5_000;

const UPGRADE_IN_PROGRESS_MSG =
  "An upgrade is already in progress for this assistant. Check `cadet ps`.";

function platformUpgradeTimeoutMs(): number {
  const override = process.env.CADET_PLATFORM_UPGRADE_TIMEOUT_MS;
  if (override) {
    const parsed = parseInt(override, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 600_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll the cloud until the upgrade completes, then confirm health.
 * Mirrors the web UI's Software Updates flow (poll the DB-backed
 * `current_release_version` rather than the gateway, which bounces while
 * the service group restarts).
 */
async function waitForPlatformUpgrade(
  entry: LockfileAssistant,
  token: string,
  pollTarget: string | null,
  initialVersion: string | null,
): Promise<void> {
  const gatewayUrl = getGatewayUrl(entry);
  const timeoutMs = platformUpgradeTimeoutMs();
  const start = Date.now();
  let sawInProgress = false;
  let lastHeartbeat = start;
  let observedVersion: string | null = initialVersion;

  console.log(
    pollTarget
      ? `⏳ Waiting for the upgrade to ${pollTarget} to complete...`
      : "⏳ Waiting for the upgrade to complete...",
  );

  while (Date.now() - start < timeoutMs) {
    await sleep(PLATFORM_POLL_INTERVAL_MS);

    // The in-progress lock is only needed when we don't know the target
    // version (server resolved "latest" without reporting it).
    const [detail, inProgress] = await Promise.all([
      fetchAssistantDetail(token, entry.assistantId, gatewayUrl),
      pollTarget
        ? Promise.resolve(null)
        : fetchUpgradeInProgress(token, entry.assistantId, gatewayUrl),
    ]);
    if (detail) observedVersion = detail.currentReleaseVersion;
    if (inProgress === true) sawInProgress = true;

    const verdict = evaluateUpgradePoll({
      targetVersion: pollTarget,
      initialVersion,
      observedVersion,
      inProgress,
      sawInProgress,
    });

    if (verdict === "complete") {
      const finalVersion = observedVersion ?? pollTarget ?? "unknown";
      const healthDeadline = Date.now() + PLATFORM_HEALTH_CONFIRM_TIMEOUT_MS;
      while (Date.now() < healthDeadline) {
        const health = await checkCloudHealth(entry);
        if (health.status === "healthy") {
          console.log(`✅ Upgraded to ${finalVersion} — assistant is healthy.`);
          return;
        }
        await sleep(PLATFORM_HEALTH_CONFIRM_INTERVAL_MS);
      }
      console.warn(
        `⚠️  Upgraded to ${finalVersion}, but the health check did not confirm. Check \`cadet ps\`.`,
      );
      return;
    }

    if (Date.now() - lastHeartbeat >= PLATFORM_POLL_HEARTBEAT_MS) {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      console.log(`   Still upgrading... (${elapsedSec}s elapsed)`);
      lastHeartbeat = Date.now();
    }
  }

  const timeoutMin = Math.round(timeoutMs / 60_000);
  console.warn(
    `⚠️  Upgrade request was accepted but completion was not confirmed within ${timeoutMin} minutes. The cloud may still be working — check \`cadet ps\` or the web settings page.`,
  );
}

async function upgradeCloud(
  entry: LockfileAssistant,
  version: string | null,
  wait: boolean,
): Promise<void> {
  const gatewayUrl = getGatewayUrl(entry);
  console.log(
    `🔄 Upgrading cloud-hosted assistant '${entry.assistantId}'...\n`,
  );

  const token = readCloudToken();
  if (!token) {
    const msg =
      "Error: Not logged in. Run `cadet login --token <token>` first.";
    console.error(msg);
    emitCliError("AUTH_FAILED", msg);
    process.exit(1);
  }

  // Pre-flight (all best-effort except an explicit version that the
  // platform doesn't know about): resolve the target, detect no-ops and
  // downgrades before POSTing, and bail if an upgrade is already running.
  const [assistantDetail, health] = await Promise.all([
    fetchAssistantDetail(token, entry.assistantId, gatewayUrl),
    checkCloudHealth(entry),
  ]);
  // Health probe first, DB-backed field as the sleeping-assistant fallback.
  const currentVersion =
    health.version ?? assistantDetail?.currentReleaseVersion ?? undefined;

  // Target the same platform as the detail/health/POST calls — the entry's
  // platform may differ from the active lockfile default.
  const releases = await fetchReleases();

  const resolution = resolveUpgradeTarget({
    explicitVersion: version,
    releases,
    currentVersion,
  });

  if (resolution.kind === "version-not-found") {
    const msg = `Version ${version} not found in Cadet Cloud releases.`;
    console.error(msg);
    emitCliError("MISSING_VERSION", msg);
    process.exit(1);
  }

  if (resolution.isNoOp && resolution.target) {
    console.log(`✅ Already on ${resolution.target}. Nothing to do.`);
    return;
  }

  if (resolution.isDowngrade && resolution.target && currentVersion) {
    const msg = `Cannot upgrade to an older version (${resolution.target} < ${currentVersion}). Use \`cadet restore --from <backup-path> --version ${resolution.target}\` instead.`;
    console.error(msg);
    emitCliError("VERSION_DIRECTION", msg);
    process.exit(1);
  }

  if (resolution.kind === "no-releases") {
    console.warn(
      "⚠️  Cadet Cloud releases unavailable — requesting latest from server.",
    );
  }

  const inProgress = await fetchUpgradeInProgress(
    token,
    entry.assistantId,
    gatewayUrl,
  );
  if (inProgress === true) {
    console.error(UPGRADE_IN_PROGRESS_MSG);
    emitCliError("PLATFORM_API_ERROR", UPGRADE_IN_PROGRESS_MSG);
    process.exit(1);
  }

  if (currentVersion && resolution.target) {
    console.log(`   ${currentVersion} → ${resolution.target}\n`);
  }

  const headers = await cloudAuthHeaders(token, gatewayUrl);

  const url = `${gatewayUrl || getCloudUrl()}/v1/assistants/${encodeURIComponent(entry.assistantId)}/upgrade/`;
  const body: { version?: string } = {};
  if (version) {
    body.version = version;
  }

  const response = await loopbackSafeFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    const text = await response.text();
    console.error(
      `Authentication failed (${response.status}). Run 'cadet login' to refresh.`,
    );
    emitCliError("AUTH_FAILED", "Authentication failed", text);
    try {
      await broadcastUpgradeEvent(
        gatewayUrl,
        entry.assistantId,
        buildCompleteEvent("unknown", false),
      );
    } catch {
      // Best-effort — broadcast may fail if the assistant is unreachable
    }
    process.exit(1);
  }

  if (response.status === 409) {
    const text = await response.text();
    console.error(UPGRADE_IN_PROGRESS_MSG);
    emitCliError("PLATFORM_API_ERROR", UPGRADE_IN_PROGRESS_MSG, text);
    process.exit(1);
  }

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `Error: Platform upgrade failed (${response.status}): ${text}`,
    );
    emitCliError(
      "PLATFORM_API_ERROR",
      `Platform upgrade failed (${response.status})`,
      text,
    );
    try {
      await broadcastUpgradeEvent(
        gatewayUrl,
        entry.assistantId,
        buildCompleteEvent("unknown", false),
      );
    } catch {
      // Best-effort — broadcast may fail if the assistant is unreachable
    }
    process.exit(1);
  }

  const result = (await response.json()) as UpgradeApiResponse;

  // The server resolves "latest" itself; a no-op response means nothing was
  // actually kicked off, so don't poll for a completion that will never come.
  if (result.detail?.includes("Already on the latest")) {
    console.warn(`⚠️  ${result.detail}`);
    return;
  }

  // NOTE: We intentionally do NOT broadcast a "complete" event here.
  // The cloud API returning 200 only means "upgrade request accepted" —
  // the service group has not yet restarted with the new version.  The
  // completion signal will come from the client's health-check
  // version-change detection (DaemonConnection.swift) once the new
  // version actually appears after the cloud restarts the service group.

  console.log(`✅ ${result.detail}`);
  if (result.version) {
    console.log(`   Version: ${result.version}`);
  }

  if (!wait) {
    return;
  }

  await waitForPlatformUpgrade(
    entry,
    token,
    result.version ?? resolution.target,
    currentVersion ?? null,
  );
}

/**
 * Pre-upgrade steps for the macOS app upgrade lifecycle.
 * Runs the pre-update orchestration without actually swapping containers:
 * broadcasts SSE events, creates a workspace commit, creates a backup,
 * prunes old backups, and outputs the backup path.
 */
async function upgradePrepare(
  entry: LockfileAssistant,
  version: string | null,
): Promise<void> {
  const gatewayUrl = getGatewayUrl(entry);
  const targetVersion = version ?? "unknown";
  const currentVersion = "unknown";

  // 1. Broadcast "starting" so the UI shows the progress spinner
  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildStartingEvent(targetVersion, 30),
  );

  // 2. Workspace commit: record pre-update state
  await commitWorkspaceViaGateway(
    gatewayUrl,
    entry.assistantId,
    `[assistant-upgrade] Starting: ${currentVersion} → ${targetVersion}`,
  );

  // 3. Progress: saving backup
  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildProgressEvent("Saving a backup of your data…"),
  );

  // 4. Create backup
  const backupPath = await createBackup(entry.assistantId, {
    prefix: `${entry.assistantId}-pre-upgrade`,
    description: `Pre-upgrade snapshot before ${currentVersion} → ${targetVersion}`,
  });

  if (!backupPath)
    console.warn(
      "⚠️  Pre-upgrade backup failed — continuing WITHOUT a backup; this update cannot be rolled back from one.",
    );

  // 5. Prune old backups (keep 3)
  if (backupPath) {
    pruneOldBackups(entry.assistantId, 3);
  }

  // 6. Progress: installing update
  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.INSTALLING),
  );

  // 7. Output backup path to stdout for the macOS app to parse
  if (backupPath) {
    console.log(`BACKUP_PATH:${backupPath}`);
  }
}

/**
 * Post-upgrade steps for the macOS app upgrade lifecycle.
 * Called after the app has been replaced and the daemon is back up.
 * Broadcasts a "complete" SSE event and creates a workspace commit.
 */
async function upgradeFinalize(
  entry: LockfileAssistant,
  version: string | null,
): Promise<void> {
  if (!version) {
    console.error(
      "Error: --finalize requires --version <from-version> to record the transition.",
    );
    emitCliError(
      "UNKNOWN",
      "--finalize requires --version <from-version> to record the transition",
    );
    process.exit(1);
  }

  const gatewayUrl = getGatewayUrl(entry);
  const fromVersion = version;
  const currentVersion = cliPkg.version ? `v${cliPkg.version}` : "unknown";

  // 1. Broadcast "complete" so the UI clears the progress spinner
  await broadcastUpgradeEvent(
    gatewayUrl,
    entry.assistantId,
    buildCompleteEvent(currentVersion, true),
  );

  // 2. Workspace commit: record successful update
  await commitWorkspaceViaGateway(
    gatewayUrl,
    entry.assistantId,
    `[assistant-upgrade] Complete: ${fromVersion} → ${currentVersion}\n\nresult: success`,
  );
}

/**
 * When `--latest` is passed, resolve the latest stable version from the
 * platform API.  If the running CLI is older than that version, self-update
 * the CLI via `bun install -g` and re-exec so the new CLI's upgrade logic
 * (and its cliPkg.version) drives the rest of the upgrade.
 *
 * Returns the resolved latest version string (e.g. "v0.7.0") for callers
 * that need it.  If the CLI was updated and re-exec'd, this function never
 * returns — the process is replaced.
 */
async function resolveLatestStableTag(): Promise<string> {
  console.log("🔍 Fetching latest stable release...");
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    console.error(
      "Error: Could not determine the latest stable release from Cadet Cloud or GitHub Releases.",
    );
    emitCliError(
      "UNKNOWN",
      "Could not determine the latest stable release from Cadet Cloud or GitHub Releases",
    );
    process.exit(1);
  }

  return latestVersion.startsWith("v") ? latestVersion : `v${latestVersion}`;
}

async function resolveLatestAndMaybeSelfUpdate(
  name: string | null,
  flags: { noWait: boolean; force: boolean },
): Promise<string> {
  const latestTag = await resolveLatestStableTag();
  const currentTag = cliPkg.version ? `v${cliPkg.version}` : null;

  console.log(`   Latest stable: ${latestTag}`);
  console.log(`   CLI version:   ${currentTag ?? "unknown"}\n`);

  // Check if the CLI needs updating
  const cmp = currentTag ? compareVersions(latestTag, currentTag) : null;
  if (cmp !== null && cmp > 0) {
    console.log(`🔄 Updating CLI to ${latestTag}...`);
    const installResult = spawnSync(
      "bun",
      ["install", "-g", `cadet@${stripVersionPrefix(latestTag)}`],
      { stdio: "inherit", windowsHide: true },
    );
    if (installResult.error || installResult.status !== 0) {
      const detail =
        installResult.error?.message ??
        `exited with code ${installResult.status}`;
      console.error(`\n❌ CLI self-update failed: ${detail}`);
      emitCliError("CLI_UPDATE_FAILED", "CLI self-update failed", detail);
      process.exit(1);
    }
    console.log(`✅ CLI updated to ${latestTag}\n`);

    // Re-exec with the updated CLI. Pass --version instead of --latest
    // to avoid re-fetching and to prevent infinite re-exec loops; forward
    // the other flags so the re-exec keeps the requested semantics.
    const reexecArgs = ["upgrade"];
    if (name) reexecArgs.push(name);
    reexecArgs.push("--version", latestTag);
    if (flags.noWait) reexecArgs.push("--no-wait");
    if (flags.force) reexecArgs.push("--force");

    console.log(`🚀 Re-running upgrade with updated CLI...\n`);
    const reexecResult = spawnSync("cadet", reexecArgs, {
      stdio: "inherit",
      windowsHide: true,
    });
    process.exit(reexecResult.status ?? 1);
  }

  if (cmp !== null && cmp === 0) {
    console.log(`✅ CLI is already on the latest version (${latestTag})\n`);
  }

  return latestTag;
}

export const upgrade = Object.assign(
  async function upgrade(): Promise<void> {
    const { name, version, latest, prepare, finalize, noWait, force } =
      parseArgs();
    const entry = resolveTargetAssistant(name);

    if (prepare) {
      await upgradePrepare(entry, version);
      return;
    }

    if (finalize) {
      await upgradeFinalize(entry, version);
      return;
    }

    // When --latest is passed, resolve the target from the cloud API and
    // self-update the CLI if it's behind.  The resolved version is then used
    // as the explicit target for the rest of the upgrade flow.
    let effectiveVersion = version;
    const cloud = entry.cloud;
    if (latest) {
      effectiveVersion =
        cloud === "local"
          ? await resolveLatestStableTag()
          : await resolveLatestAndMaybeSelfUpdate(name, {
              noWait,
              force,
            });
    }

    try {
      if (isDockerEntry(entry)) {
        await upgradeDocker(entry, effectiveVersion, force);
        return;
      }

      if (isLocalEntry(entry)) {
        await upgradeLocal(entry, effectiveVersion, force);
        return;
      }

      if (isCloudHome(cloud)) {
        await upgradeCloud(entry, effectiveVersion, !noWait);
        return;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Upgrade failed: ${detail}`);
      // Best-effort: notify connected clients that the upgrade failed.
      // A `starting` event may have been sent inside upgradeDocker/upgradeCloud
      // before the error was thrown, so we must close with `complete`.
      await broadcastUpgradeEvent(
        getGatewayUrl(entry),
        entry.assistantId,
        buildCompleteEvent("unknown", false),
      );
      emitCliError(categorizeUpgradeError(err), "Upgrade failed", detail);
      process.exit(1);
    }

    const msg = `Error: Upgrade is not supported for '${cloud}' assistants. Only 'local', 'docker', and 'cadet' assistants can be upgraded via the CLI.`;
    console.error(msg);
    emitCliError("UNSUPPORTED_TOPOLOGY", msg);
    process.exit(1);
  },
  { description: "Upgrade an assistant to a newer version" },
);
