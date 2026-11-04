/**
 * The local upgrade leg: the runtime swap on this machine. The CLI's
 * version targets the release the caller runs (a local dev build falls
 * forward to the latest stable), the pre-upgrade backup and client
 * notifications ride the lifecycle core, and a failed start restores the
 * previous runtime from the backup it just made. Narration rides the
 * caller's reporter; failures throw `UpgradeError` for the command layer
 * to map onto the CLI's error taxonomy.
 */
import { rm } from "node:fs/promises";

import {
  fetchCurrentVersion,
  ensureLocalRuntime,
  leaseGuardianToken,
  sleepAssistant,
  wakeAssistant,
} from "../..";
import type { LocalAssistant } from "../../lockfile-contract";
import type { LockfileAssistant } from "../../lockfile-contract";
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  buildProgressEvent,
  buildStartingEvent,
  buildUpgradeCommitMessage,
  commitWorkspaceViaGateway,
  UPGRADE_PROGRESS,
  UpgradeError,
  waitForReady,
} from "../../upgrade-lifecycle";
import type { LifecycleReporter } from "../../lifecycle-reporter";
import { createBackup, pruneOldBackups, restoreBackup } from "../../backup-ops";
import { compareVersions, versionsEqual } from "../../version-compat";
import { stripVersionPrefix } from "../../version";
import { fetchLatestVersion } from "../../cloud-releases";
import { isLocalVersion } from "@mycadet/shared/version";

export interface UpgradeLocalParams {
  entry: LocalAssistant;
  /** The explicit target version; null = the caller's own release. */
  version: string | null;
  /** The caller's own release version — the default target. */
  cliVersion?: string;
  force: boolean;
  reporter: LifecycleReporter;
}

export async function targetVersionFromCli(
  version: string | null,
  cliVersion: string | undefined,
  reporter: LifecycleReporter,
  resolveLatestStable: () => Promise<string> = resolveLatestStableTag,
): Promise<string> {
  const targetVersion = version ?? (cliVersion ? `v${cliVersion}` : "latest");
  if (!isLocalVersion(targetVersion)) return targetVersion;

  const latestTag = await resolveLatestStable();
  reporter.log(
    `   Local build version ${targetVersion} is not published; using latest stable ${latestTag}.\n`,
  );
  return latestTag;
}

async function ensureGuardianTokenAfterLocalUpgrade(
  entry: LockfileAssistant,
  reporter: LifecycleReporter,
): Promise<void> {
  const log = (msg: string) => reporter.log(msg);
  const warn = (msg: string) => reporter.warn(msg);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Pairing IS the repair — re-pair mints a fresh device-bound pair for
      // the existing guardian under the loopback presence proof.
      await leaseGuardianToken(entry);
      log("   Re-provisioned guardian token.");
      return;
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      } else {
        warn(
          `   Guardian token re-provision failed after ${maxAttempts} attempts: ${err}`,
        );
      }
    }
  }
}

export async function upgradeLocal(
  params: UpgradeLocalParams,
): Promise<string | undefined> {
  const { reporter } = params;
  const log = (msg: string) => reporter.log(msg);
  const warn = (msg: string) => reporter.warn(msg);
  const err = (msg: string) => reporter.error(msg);
  const entry = params.entry;
  const version = params.version;
  const force = params.force;
  const targetVersion = await targetVersionFromCli(
    version,
    params.cliVersion,
    reporter,
  );
  const adminUrl = `http://127.0.0.1:${entry.port}`;
  const currentVersion = await fetchCurrentVersion(adminUrl);

  if (!currentVersion && targetVersion) {
    warn(
      "⚠️  Could not determine current version from health endpoint — skipping version-direction check.\n",
    );
  }
  if (currentVersion && targetVersion) {
    const cmp = compareVersions(targetVersion, currentVersion);
    if (cmp !== null && cmp < 0) {
      throw new UpgradeError(
        "VERSION_DIRECTION",
        `Cannot upgrade to an older version (${targetVersion} < ${currentVersion}). Use \`cadet restore --from <backup-path> --version ${targetVersion}\` instead.`,
      );
    }
  }

  if (currentVersion && versionsEqual(targetVersion, currentVersion)) {
    if (!force) {
      log(
        `✅ Already on ${targetVersion}. Nothing to do. Pass --force to reinstall.`,
      );
      return;
    }
    log(`🔁 Reinstalling ${targetVersion} with --force...\n`);
  }

  log(
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

  log("📢 Notifying connected clients...");
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
  log("📦 Creating pre-upgrade backup...");
  const backupPath = await createBackup(entry.assistantId, {
    prefix: `${entry.assistantId}-pre-upgrade`,
    description: `Pre-upgrade snapshot before ${currentVersion ?? "unknown"} → ${targetVersion}`,
  });
  if (backupPath) {
    log(`   Backup saved: ${backupPath}\n`);
    pruneOldBackups(entry.assistantId, 3);
  } else {
    warn(
      "⚠️  Pre-upgrade backup failed — continuing WITHOUT a backup; this upgrade cannot be rolled back from one.",
    );
  }

  await broadcastUpgradeEvent(
    adminUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.INSTALLING),
  );

  log(
    "⬇️  Downloading local runtime packages (assistant, gateway, credential-executor)...",
  );
  const runtimeInstall = ensureLocalRuntime(entry, targetVersion, {
    force,
  });
  const upgradedEntry = entry;
  log(`   Runtime installed: ${runtimeInstall.installDir}\n`);

  try {
    log("🛑 Stopping local assistant processes...");
    // force: the upgrade's teardown must not be refused the way a user's
    // `cadet sleep` can be — the lease guard protects live calls, but this
    // stop is the upgrade's own midpoint.
    const stopped = await sleepAssistant(upgradedEntry, { force: true });
    if (!stopped.ok) throw new Error(stopped.error);
    log("✅ Local assistant processes stopped\n");

    log("🚀 Starting upgraded local assistant...");
    // The upgraded daemons must report the version they now run: the child
    // processes inherit APP_VERSION, pinned around the wake only.
    const previousAppVersion = process.env.APP_VERSION;
    process.env.APP_VERSION = stripVersionPrefix(targetVersion);
    try {
      await wakeAssistant(upgradedEntry);
    } finally {
      if (previousAppVersion === undefined) {
        delete process.env.APP_VERSION;
      } else {
        process.env.APP_VERSION = previousAppVersion;
      }
    }
    await ensureGuardianTokenAfterLocalUpgrade(entry, reporter);
    log("✅ Local assistant processes started\n");

    log("Waiting for assistant to become ready...");
    const ready = await waitForReady(adminUrl);
    if (!ready) {
      await broadcastUpgradeEvent(
        adminUrl,
        entry.assistantId,
        buildCompleteEvent(currentVersion ?? "unknown", false),
      );
      const msg = `Upgrade to ${targetVersion} failed: local assistant did not become ready.`;
      err(`\n❌ ${msg}`);
      throw new Error(msg);
    }
  } catch (error) {
    err(
      "Local upgrade failed; restoring the previous runtime and service roots...",
    );
    await sleepAssistant(upgradedEntry, { force: true });
    // The lockfile no longer records the runtime install — the newest
    // directory under the instance's runtime/ root is what the next wake
    // derives, so a failed upgrade's install must leave, or that wake
    // would pick the runtime that just failed to start.
    await rm(runtimeInstall.installDir, { recursive: true, force: true });
    if (backupPath) {
      const restored = await restoreBackup(entry.assistantId, backupPath, {
        resume: false,
      });
      if (!restored)
        throw new Error(
          `Local recovery failed; services remain stopped. Backup: ${backupPath}`,
          { cause: error },
        );
      await wakeAssistant(entry);
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

  log(
    `\n✅ Local assistant '${entry.assistantId}' upgraded to ${targetVersion}.`,
  );

  return stripVersionPrefix(targetVersion);
}

/**
 * The latest stable release tag from the platform API, normalized to a
 * `v`-prefixed tag. Exits through `UpgradeError` when the platform (and
 * GitHub) answer nothing.
 */
export async function resolveLatestStableTag(): Promise<string> {
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    throw new UpgradeError(
      "UNKNOWN",
      "Could not determine the latest stable release from Cadet Cloud or GitHub Releases",
    );
  }

  return latestVersion.startsWith("v") ? latestVersion : `v${latestVersion}`;
}
