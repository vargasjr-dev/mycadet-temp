/**
 * The upgrade operation: swap an existing assistant to a new version. Unlike
 * the hatch it takes an ENTRY — the router switches on `entry.cloud`, not a
 * requested remote. The local and docker legs own their machine-side
 * mechanics (backup, restart, rollback); the cloud leg drives the platform;
 * `prepare`/`finalize` are the macOS app's two-phase lifecycle (they ride
 * whichever entry the app is upgrading). Narration rides the caller's
 * reporter; failures throw `UpgradeError`, which the router maps onto its
 * result union (the code IS the CLI's error category).
 */
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  buildProgressEvent,
  buildStartingEvent,
  commitWorkspaceViaGateway,
  UPGRADE_PROGRESS,
  UpgradeError,
} from "../upgrade-lifecycle";
import type { LifecycleReporter } from "../lifecycle-reporter";
import { createBackup, pruneOldBackups } from "../backup-ops";
import {
  isDockerEntry,
  isLocalEntry,
  getGatewayUrl,
} from "../lockfile-contract";
import { isCloudEntry, type LockfileAssistant } from "../lockfile-contract";
import { upgradeDocker } from "../remotes/docker/upgrade";
import { upgradeLocal } from "../remotes/local/upgrade";
import { upgradeCloud } from "../remotes/cloud/upgrade";
import { consoleLifecycleReporter } from "../lifecycle-reporter";

interface UpgradeAssistantParams {
  entry: LockfileAssistant;
  /** The explicit target version; null = the caller's own release. */
  version?: string | null;
  /** The caller's own release version — the default target and the
   * finalize's "current" version (the CLI passes its package version). */
  cliVersion?: string;
  /** local/docker: reinstall even when already on the target. */
  force?: boolean;
  /** cloud: wait for the platform to confirm completion (default true). */
  wait?: boolean;
  /** macOS pre-upgrade phase: backup + notify, no version swap. */
  prepare?: boolean;
  /** macOS post-upgrade phase: the version being upgraded FROM. */
  finalizeFromVersion?: string | null;
  reporter?: LifecycleReporter;
}

type UpgradeAssistantResult =
  | { ok: true; version?: string }
  | { ok: false; status: number; error: string; code?: string };

export async function upgradeAssistant(
  params: UpgradeAssistantParams,
): Promise<UpgradeAssistantResult> {
  const reporter = params.reporter;
  const entry = params.entry;
  try {
    if (params.prepare) {
      await upgradePrepare(entry, params.version ?? null, reporter);
      return { ok: true };
    }

    if (params.finalizeFromVersion !== undefined) {
      await upgradeFinalize(
        entry,
        params.finalizeFromVersion,
        params.cliVersion,
        reporter,
      );
      return { ok: true };
    }

    if (isDockerEntry(entry)) {
      await upgradeDocker({
        entry,
        version: params.version ?? null,
        cliVersion: params.cliVersion ?? "",
        force: params.force ?? false,
        reporter: reporter ?? consoleLifecycleReporter,
      });
      return { ok: true, version: params.version ?? undefined };
    }

    if (isLocalEntry(entry)) {
      const version = await upgradeLocal({
        entry,
        version: params.version ?? null,
        cliVersion: params.cliVersion,
        force: params.force ?? false,
        reporter: reporter ?? consoleLifecycleReporter,
      });
      return { ok: true, version: version ?? undefined };
    }

    if (isCloudEntry(entry)) {
      await upgradeCloud({
        entry,
        version: params.version,
        wait: params.wait ?? true,
        reporter: reporter ?? consoleLifecycleReporter,
      });
      return { ok: true };
    }

    const msg = `Upgrade is not supported for '${entry.cloud}' assistants. Only 'local', 'docker', and 'cadet' assistants can be upgraded via the CLI.`;
    return { ok: false, status: 400, error: msg, code: "UNSUPPORTED_TOPOLOGY" };
  } catch (err) {
    if (err instanceof UpgradeError) {
      return {
        ok: false,
        status: upgradeErrorStatus(err.code),
        error: err.message,
        code: err.code,
      };
    }
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
      code: "UNKNOWN",
    };
  }
}

/** The platform's status codes the command layer's taxonomy expects. */
function upgradeErrorStatus(code: string): number {
  switch (code) {
    case "AUTH_FAILED":
      return 401;
    case "UNSUPPORTED_TOPOLOGY":
    case "MISSING_VERSION":
      return 400;
    default:
      return 500;
  }
}

export async function upgradePrepare(
  entry: LockfileAssistant,
  version: string | null,
  reporter?: LifecycleReporter,
): Promise<void> {
  const log = (msg: string): void => reporter?.log(msg) ?? console.log(msg);
  const warn = (msg: string): void => reporter?.warn(msg) ?? console.warn(msg);
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
    warn(
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
    log(`BACKUP_PATH:${backupPath}`);
  }
}

export async function upgradeFinalize(
  entry: LockfileAssistant,
  version: string | null,
  cliVersion?: string,
  reporter?: LifecycleReporter,
): Promise<void> {
  const log = (msg: string): void => reporter?.log(msg) ?? console.log(msg);
  const err = (msg: string): void => reporter?.error(msg) ?? console.error(msg);
  if (!version) {
    throw new UpgradeError(
      "UNKNOWN",
      "--finalize requires --version <from-version> to record the transition",
    );
  }

  const gatewayUrl = getGatewayUrl(entry);
  const fromVersion = version;
  const currentVersion = cliVersion ? `v${cliVersion}` : "unknown";

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
