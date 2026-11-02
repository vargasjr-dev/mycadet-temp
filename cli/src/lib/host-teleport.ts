import { rm } from "node:fs/promises";
import { getGatewayUrl, isDockerEntry } from "@mycadet/local-mode/contract";
import cliPkg from "../../package.json";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { findAssistantByName, setActiveAssistant } from "./assistant-config.js";
import { createBackup, pruneOldBackups } from "./backup-ops.js";
import { hatchDocker, recreateDockerContainers } from "./remotes/docker.js";
import { hatchLocal } from "./remotes/local.js";
import {
  removeLockfileAssistant,
  retireDocker,
  retireLocal,
  validateAssistantName,
} from "@mycadet/local-mode";
import {
  DockerRootStorage,
  LocalRootStorage,
  restoreRootBackup,
  stageRootArchive,
  STATE_ROOTS,
  withRootOperationLock,
} from "./root-backup.js";
import { fetchCurrentVersion } from "@mycadet/local-mode";
import { compareVersions } from "./version-compat.js";
import { sleepAssistant, wakeAssistant } from "@mycadet/local-mode";
import { generateInstanceName } from "@mycadet/local-mode";

type HostStorage = LocalRootStorage | DockerRootStorage;
type HostEnvironment = "local" | "docker";

export class TeleportRecoveryError extends AggregateError {}

export interface HostTeleportOps {
  storage(entry: LockfileAssistant): HostStorage;
  backup(entry: LockfileAssistant): Promise<string>;
  hatch(
    env: HostEnvironment,
    name: string | undefined,
    archive: string,
  ): Promise<LockfileAssistant>;
  restore(
    entry: LockfileAssistant,
    archive: string,
    recovery: string,
  ): Promise<void>;
  retire(entry: LockfileAssistant): Promise<void>;
}

export function storageFor(entry: LockfileAssistant): HostStorage {
  return entry.cloud === "docker"
    ? new DockerRootStorage(entry)
    : new LocalRootStorage(entry);
}

const defaultOps: HostTeleportOps = {
  storage: storageFor,
  backup: async (entry) => {
    const archive = await createBackup(entry.assistantId, {
      prefix: `${entry.assistantId}-pre-teleport`,
    });
    if (!archive) {
      throw new Error(
        `Could not capture '${entry.assistantId}'; teleport aborted.`,
      );
    }
    console.log(`Backup saved: ${archive}`);
    return archive;
  },
  hatch: async (env, name, initialArchive) => {
    const instanceName = generateInstanceName(name ?? null);
    if (findAssistantByName(instanceName)) {
      throw new Error(`Assistant '${instanceName}' already exists.`);
    }
    try {
      if (env === "docker") {
        await hatchDocker({
          name: instanceName,
          setupProviderCredentials: false,
          initialArchive,
        });
      } else {
        await hatchLocal({
          name: instanceName,
          setupProviderCredentials: false,
        });
      }
      const entry = findAssistantByName(instanceName);
      if (!entry) {
        throw new Error("Could not find the newly hatched teleport target.");
      }
      return entry;
    } catch (error) {
      const entry = findAssistantByName(instanceName);
      if (entry) {
        await sleepAssistant(entry);
        await defaultOps.retire(entry);
      }
      throw error;
    }
  },
  restore: restoreHostTeleportTarget,
  retire: async (entry) => {
    if (entry.cloud === "docker") {
      await retireDocker(entry.assistantId);
    } else {
      await retireLocal(entry.assistantId, entry);
    }
    removeLockfileAssistant(entry.assistantId);
  },
};

function checkVersion(
  source: string | undefined,
  target: string | undefined,
): void {
  const comparison = source && target ? compareVersions(target, source) : null;
  if (comparison !== null && comparison < 0) {
    throw new Error(
      `Target runtime ${target} is older than source ${source}. Upgrade the target before teleporting.`,
    );
  }
}

export async function teleportHostInstallation(
  source: LockfileAssistant,
  targetEnv: HostEnvironment,
  targetName: string | undefined,
  options: { dryRun: boolean; keepSource: boolean },
  ops = defaultOps,
): Promise<void> {
  const existing = targetName ? findAssistantByName(targetName) : null;
  const work = () =>
    performHostTeleport(source, targetEnv, targetName, existing, options, ops);
  if (options.dryRun) {
    return work();
  }
  return withRootOperationLock(source, () =>
    existing ? withRootOperationLock(existing, work) : work(),
  );
}

async function performHostTeleport(
  source: LockfileAssistant,
  targetEnv: HostEnvironment,
  targetName: string | undefined,
  existing: LockfileAssistant | null,
  options: { dryRun: boolean; keepSource: boolean },
  ops: HostTeleportOps,
): Promise<void> {
  if (existing && existing.cloud !== targetEnv) {
    throw new Error(
      `Assistant '${targetName}' is a ${existing.cloud} assistant, not ${targetEnv}.`,
    );
  }
  if (targetName && !existing) {
    validateAssistantName(targetName);
  }
  if (options.dryRun) {
    console.log(
      `Would move ${STATE_ROOTS.join(", ")} from '${source.assistantId}' to ${existing ? `'${existing.assistantId}'` : `a new ${targetEnv} assistant`}.`,
    );
    console.log(
      "Would gracefully sleep services, save root tar safety backups, restore all roots, and verify the destination.",
    );
    console.log(
      options.keepSource
        ? "Would keep the source stopped."
        : "Would retire the source only after the destination is ready.",
    );
    console.log("Dry run complete. No services stopped or archives created.");
    return;
  }

  const sourceVersion = await fetchCurrentVersion(getGatewayUrl(source));
  checkVersion(
    sourceVersion,
    existing
      ? await fetchCurrentVersion(getGatewayUrl(existing))
      : cliPkg.version,
  );
  const sourceStorage = ops.storage(source);
  const sourceWasRunning = await sourceStorage.running();
  let target: LockfileAssistant | undefined;
  let ready = false;
  try {
    await sleepAssistant(source);
    if (await sourceStorage.running()) {
      throw new Error("Source services are still running; teleport aborted.");
    }
    // This exact snapshot is both the safety backup and the transferred state.
    const archive = await ops.backup(source);
    if (existing) {
      target = existing;
      const targetStorage = ops.storage(target);
      const targetWasRunning = await targetStorage.running();
      try {
        await sleepAssistant(target);
        if (await targetStorage.running()) {
          throw new Error(
            "Target services are still running; teleport aborted.",
          );
        }
        const recovery = await ops.backup(target);
        await ops.restore(target, archive, recovery);
      } catch (error) {
        if (targetWasRunning && !(error instanceof TeleportRecoveryError)) {
          const woken = await wakeAssistant(target);
          if (!woken.ok) throw new Error(woken.error);
        }
        throw error;
      }
    } else {
      target = await ops.hatch(targetEnv, targetName, archive);
      checkVersion(
        sourceVersion,
        await fetchCurrentVersion(getGatewayUrl(target)),
      );
      const hatched = await wakeAssistant(target);
      if (!hatched.ok) throw new Error(hatched.error);
    }
    ready = true;
    setActiveAssistant(target.assistantId);
    if (options.keepSource) {
      console.log(
        `Source '${source.assistantId}' retained, stopped, via --keep-source.`,
      );
    } else {
      if (await sourceStorage.running()) {
        throw new Error(
          "Source was restarted during teleport. Destination is ready; source was retained to preserve newer writes.",
        );
      }
      await ops.retire(source);
    }
    pruneOldBackups(source.assistantId, 3, "pre-teleport");
    if (existing) {
      pruneOldBackups(existing.assistantId, 3, "pre-teleport");
    }
    console.log(
      `Teleport complete: ${source.assistantId} → ${target.assistantId}`,
    );
  } catch (error) {
    if (!ready) {
      if (target && !existing) {
        await sleepAssistant(target);
        await ops.retire(target);
      }
      if (sourceWasRunning) {
        const woken = await wakeAssistant(source);
        if (!woken.ok) throw new Error(woken.error);
      }
    }
    throw error;
  }
}

/**
 * Restore a teleported root on the TARGET machine: import the archive into
 * the (stopped) target, then sleep + wake — the wake recreates the service
 * group from the imported entry's recorded images, so the destination's
 * pre-teleport container state plays no role (the replay that shadowed the
 * imported root's identity died with it). On any failure the recovery
 * archive — the target's own pre-teleport root — is imported and the same
 * sleep + wake revives it; a failed recovery rethrows as
 * {@link TeleportRecoveryError}.
 */
export async function restoreHostTeleportTarget(
  entry: LockfileAssistant,
  archive: string,
  recovery: string,
): Promise<void> {
  const stage = await stageRootArchive(archive);
  await rm(stage, { recursive: true, force: true });
  if (await storageFor(entry).running()) {
    throw new Error("Target services must be stopped before teleport restore.");
  }
  const originalRuntime =
    entry.cloud !== "cloud" &&
    entry.cloud !== "custom" &&
    entry.cloud !== "baseten"
      ? {
          runtimeVersion: entry.runtimeVersion,
          runtimeInstallDir: entry.runtimeInstallDir,
        }
      : undefined;
  const revive = async () => {
    const stopped = await sleepAssistant(entry);
    if (!stopped.ok) throw new Error(stopped.error);
    let woken = await wakeAssistant(entry);
    if (!woken.ok && woken.status === 404 && isDockerEntry(entry)) {
      await recreateDockerContainers(entry);
      woken = await wakeAssistant(entry);
    }
    if (!woken.ok) throw new Error(woken.error);
  };
  try {
    await restoreRootBackup(entry, archive, { resume: false });
    await revive();
  } catch (error) {
    try {
      await sleepAssistant(entry);
      if (
        entry.cloud !== "cloud" &&
        entry.cloud !== "custom" &&
        entry.cloud !== "baseten"
      ) {
        entry.runtimeVersion = originalRuntime?.runtimeVersion;
        entry.runtimeInstallDir = originalRuntime?.runtimeInstallDir;
      }
      await restoreRootBackup(entry, recovery, { resume: false });
      await revive();
    } catch (recoveryError) {
      throw new TeleportRecoveryError(
        [error, recoveryError],
        `Teleport target recovery failed; keep services stopped. Restore ${recovery}.`,
      );
    }
    throw error;
  }
}
