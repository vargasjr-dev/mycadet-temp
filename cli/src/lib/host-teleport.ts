import { rm } from "node:fs/promises";
import { getGatewayUrl, isDockerEntry } from "@mycadet/local-mode/contract";
import { z } from "zod";
import cliPkg from "../../package.json";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { findAssistantByName, setActiveAssistant } from "./assistant-config.js";
import { createBackup, pruneOldBackups } from "./backup-ops.js";
import {
  dockerResourceNames,
  hatchDocker,
  startContainers,
} from "./remotes/docker.js";
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
import { DOCKER_STATEFUL_SET_SPEC } from "./statefulset.js";
import { execOutput } from "./step-runner.js";
import { buildReplayState } from "./upgrade-lifecycle.js";
import { fetchCurrentVersion } from "./http-client.js";
import { compareVersions } from "./version-compat.js";
import { sleepAssistant } from "../commands/sleep.js";
import { generateInstanceName } from "./random-name.js";

type HostStorage = LocalRootStorage | DockerRootStorage;
type HostEnvironment = "local" | "docker";

export class TeleportRecoveryError extends AggregateError {}

export interface HostTeleportOps {
  storage(entry: LockfileAssistant): HostStorage;
  sleep(entry: LockfileAssistant): Promise<void>;
  backup(entry: LockfileAssistant): Promise<string>;
  version(entry: LockfileAssistant): Promise<string | undefined>;
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
  sleep: (entry) =>
    sleepAssistant(entry, { force: false, wait: false, waitMs: null }),
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
  version: async (entry) => await fetchCurrentVersion(getGatewayUrl(entry)),
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
          initialArchive,
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
        await defaultOps.sleep(entry);
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

async function startAndCheck(storage: HostStorage): Promise<void> {
  storage.initialRunning =
    storage instanceof DockerRootStorage
      ? new Set(Object.values(storage.containers))
      : new Set(["ces", "assistant", "gateway"]);
  await storage.resume();
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

  const sourceVersion = await ops.version(source);
  checkVersion(
    sourceVersion,
    existing ? await ops.version(existing) : cliPkg.version,
  );
  const sourceStorage = ops.storage(source);
  const sourceWasRunning = await sourceStorage.running();
  let target: LockfileAssistant | undefined;
  let ready = false;
  try {
    await ops.sleep(source);
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
        await ops.sleep(target);
        if (await targetStorage.running()) {
          throw new Error(
            "Target services are still running; teleport aborted.",
          );
        }
        const recovery = await ops.backup(target);
        await ops.restore(target, archive, recovery);
      } catch (error) {
        if (targetWasRunning && !(error instanceof TeleportRecoveryError)) {
          await targetStorage.resume();
        }
        throw error;
      }
    } else {
      target = await ops.hatch(targetEnv, targetName, archive);
      checkVersion(sourceVersion, await ops.version(target));
      await startAndCheck(ops.storage(target));
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
        await ops.sleep(target);
        await ops.retire(target);
      }
      if (sourceWasRunning) {
        await sourceStorage.resume();
      }
    }
    throw error;
  }
}

const DockerConfiguration = z.object({
  Id: z.string().optional(),
  Image: z.string().min(1),
  Config: z.object({ Env: z.array(z.string()), User: z.string() }),
  HostConfig: z.object({ NetworkMode: z.string() }),
  Mounts: z.array(
    z.object({
      Type: z.string(),
      Name: z.string().optional(),
      Destination: z.string(),
      RW: z.boolean(),
    }),
  ),
});

/** Recreate standard CLI containers so immutable env cannot override imported identity. */
async function dockerReplacementOptions(
  entry: LockfileAssistant,
): Promise<Parameters<typeof startContainers>[0]> {
  if (!isDockerEntry(entry)) {
    throw new Error(
      `'${entry.assistantId}' is not a docker assistant — teleport expects a docker target.`,
    );
  }
  const res = dockerResourceNames(entry.assistantId);
  const states = new Map<string, z.infer<typeof DockerConfiguration>>();
  for (const container of [
    res.assistantContainer,
    res.gatewayContainer,
    res.cesContainer,
  ]) {
    const parsed = z
      .array(DockerConfiguration)
      .length(1)
      .safeParse(
        JSON.parse(await execOutput("docker", ["inspect", container])),
      );
    if (!parsed.success) {
      throw new Error(`Cannot read Docker configuration for ${container}.`);
    }
    states.set(container, parsed.data[0]!);
  }
  const containerByService = {
    assistant: res.assistantContainer,
    gateway: res.gatewayContainer,
    "credential-executor": res.cesContainer,
  };
  for (const spec of DOCKER_STATEFUL_SET_SPEC.containers) {
    const state = states.get(containerByService[spec.internalName])!;
    const expectedNetwork =
      spec.network === "bridge"
        ? res.network
        : `container:${res.assistantContainer}`;
    const assistantId = states.get(res.assistantContainer)!.Id;
    if (
      state.HostConfig.NetworkMode !== expectedNetwork &&
      !(
        spec.network === "container" &&
        assistantId &&
        state.HostConfig.NetworkMode === `container:${assistantId}`
      )
    ) {
      throw new Error(
        "Teleport into a customized Docker network requires a newly hatched target.",
      );
    }
    if (state.Mounts.length !== spec.volumeMounts.length) {
      throw new Error(
        "Teleport into customized Docker mounts requires a newly hatched target.",
      );
    }
    for (const mount of spec.volumeMounts) {
      const volume = DOCKER_STATEFUL_SET_SPEC.volumeClaimTemplates.find(
        (volume) => volume.name === mount.volumeName,
      )!;
      const found = state.Mounts.find(
        (item) => item.Destination === mount.mountPath,
      );
      if (
        !found ||
        found.Type !== "volume" ||
        found.Name !== volume.dockerVolume(entry.assistantId) ||
        found.RW !== !mount.readOnly
      ) {
        throw new Error(
          "Teleport into customized Docker mounts requires a newly hatched target.",
        );
      }
    }
  }
  const env = (container: string) =>
    Object.fromEntries(
      states.get(container)!.Config.Env.map((value) => {
        const index = value.indexOf("=");
        return [value.slice(0, index), value.slice(index + 1)];
      }),
    );
  const replay = buildReplayState(
    env(res.assistantContainer),
    env(res.gatewayContainer),
  );
  const gatewayUrl = getGatewayUrl(entry);
  const gatewayPort = Number(new URL(gatewayUrl).port);
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1) {
    throw new Error(
      "Docker target is missing its published ports. Use a newly hatched target.",
    );
  }
  return {
    ...replay,
    gatewayPort,
    imageTags: {
      assistant: states.get(res.assistantContainer)!.Image,
      gateway: states.get(res.gatewayContainer)!.Image,
      "credential-executor": states.get(res.cesContainer)!.Image,
    },
    instanceName: entry.assistantId,
    res,
    createOnly: true,
  };
}

export async function restoreHostTeleportTarget(
  entry: LockfileAssistant,
  archive: string,
  recovery: string,
): Promise<void> {
  const stage = await stageRootArchive(archive);
  await rm(stage, { recursive: true, force: true });
  const previous =
    entry.cloud === "docker"
      ? await dockerReplacementOptions(entry)
      : undefined;
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
  const replaceContainers = async (
    opts: Parameters<typeof startContainers>[0],
  ) => {
    const storage = new DockerRootStorage(entry);
    if (await storage.running()) {
      throw new Error(
        "Docker services must be stopped before container replacement.",
      );
    }
    for (const container of [
      opts.res.assistantContainer,
      opts.res.gatewayContainer,
      opts.res.cesContainer,
    ]) {
      await execOutput("docker", ["rm", container]);
    }
    await startContainers(opts, (message) => console.log(message));
  };
  try {
    if (previous) {
      // The captured destination env replays wholesale — including this
      // machine's ACTOR_TOKEN_SIGNING_KEY, which (env beats file) shadows
      // the imported root's key. The signing-key-level disposition is open.
      await replaceContainers(previous);
    }
    await restoreRootBackup(entry, archive, { resume: false });
    await startAndCheck(storageFor(entry));
  } catch (error) {
    try {
      await defaultOps.sleep(entry);
      if (previous) {
        // Failed creation can leave an incomplete service group.
        for (const container of [
          previous.res.assistantContainer,
          previous.res.gatewayContainer,
          previous.res.cesContainer,
        ]) {
          try {
            await execOutput("docker", ["rm", container]);
          } catch (removeError) {
            if (
              !String(removeError).toLowerCase().includes("no such container")
            ) {
              throw removeError;
            }
          }
        }
        await startContainers(previous, (message) => console.log(message));
      }
      if (
        entry.cloud !== "cloud" &&
        entry.cloud !== "custom" &&
        entry.cloud !== "baseten"
      ) {
        entry.runtimeVersion = originalRuntime?.runtimeVersion;
        entry.runtimeInstallDir = originalRuntime?.runtimeInstallDir;
      }
      await restoreRootBackup(entry, recovery, { resume: false });
    } catch (recoveryError) {
      throw new TeleportRecoveryError(
        [error, recoveryError],
        `Teleport target recovery failed; keep services stopped. Restore ${recovery}.`,
      );
    }
    throw error;
  }
}
