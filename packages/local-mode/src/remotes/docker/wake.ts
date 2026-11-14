import { platform } from "node:os";

import type { DockerAssistant } from "../../lockfile-contract";
import { exec } from "../../exec";
import { saveLockfileAssistant } from "../../lockfile";
import { getOrCreateHostDeviceId } from "../../device-id";
import { ASSISTANT_INTERNAL_PORT } from "../../ports";
import { dockerResourceNames } from "./retire";
import { ensureDockerDaemonRunning, isNoSuchContainerError } from "./common";
import { pullImage } from "./hatch";
import {
  buildServiceRunArgs,
  resolveAvatarDevicePath,
  stopContainers,
  type ServiceName,
} from "./statefulset";
import { waitForReady } from "../../daemon-readiness";
import type { WakeResult } from "../../operations/wake";

/**
 * The docker topology's wake leg: start the instance's three service
 * containers by their derived resource names. On macOS the Docker daemon is
 * brought up first (Colima fallback) — a slept assistant on a rebooted Mac
 * must wake without a manual `colima start`.
 *
 * Never throws: a container that was never created (a migrated install with
 * data in the volumes but no containers) is recreated from the entry's
 * recorded images and the start retried once; every other failure is a 500
 * carrying the docker error.
 */
export interface WakeDockerOptions {
  /** Recreate the group from these images instead of the entry's recorded ones (the upgrade's fresh stamps). */
  imageTags?: Record<ServiceName, string>;
  extraAssistantEnv?: Record<string, string>;
  extraGatewayEnv?: Record<string, string>;
  gatewayPort?: number;
  /** Wait for the gateway's `/readyz` after the containers come up. */
  waitUntilReady?: boolean;
  log?: (msg: string) => void;
}

export async function wakeDocker(
  entry: DockerAssistant,
  options: WakeDockerOptions = {},
): Promise<WakeResult> {
  const log = options.log ?? ((msg: string): void => console.log(msg));
  const startAll = async (): Promise<void> => {
    const res = dockerResourceNames(entry.assistantId);
    for (const container of [
      res.assistantContainer,
      res.gatewayContainer,
      res.cesContainer,
    ]) {
      await exec("docker", ["start", container]);
    }
  };
  try {
    if (platform() !== "linux") {
      await ensureDockerDaemonRunning();
    }
    await startAll();
    log("Docker containers started.");
  } catch (err) {
    if (!isNoSuchContainerError(err)) {
      return {
        ok: false,
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    log(
      `Containers for '${entry.assistantId}' don't exist yet — recreating from the recorded images...`,
    );
    try {
      await recreateDockerContainers(entry, options);
      await startAll();
    } catch (recreateErr) {
      return {
        ok: false,
        status: 500,
        error:
          recreateErr instanceof Error
            ? recreateErr.message
            : String(recreateErr),
      };
    }
    log("Docker containers started.");
  }
  if (options.waitUntilReady) {
    const gatewayUrl = new URL(
      `http://127.0.0.1:${options.gatewayPort ?? entry.port}`,
    );
    const ready = await waitForReady(gatewayUrl.origin);
    if (!ready) {
      return {
        ok: false,
        status: 500,
        error: "Containers failed to become ready within the timeout.",
      };
    }
  }
  return { ok: true };
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
async function recreateDockerContainers(
  entry: DockerAssistant,
  options: WakeDockerOptions = {},
): Promise<void> {
  const info = entry.containerInfo;
  const assistantImage = options.imageTags?.assistant ?? info?.assistantImage;
  const gatewayImage = options.imageTags?.gateway ?? info?.gatewayImage;
  const cesImage = options.imageTags?.["credential-executor"] ?? info?.cesImage;
  if (!assistantImage || !gatewayImage || !cesImage) {
    throw new Error(
      `no container images recorded for '${entry.assistantId}' — re-hatch or run \`cadet upgrade\` to set them`,
    );
  }
  const images: Record<ServiceName, string> = {
    assistant: assistantImage,
    gateway: gatewayImage,
    "credential-executor": cesImage,
  };
  const res = dockerResourceNames(entry.assistantId);
  const log = options.log ?? ((msg: string): void => console.log(msg));

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

  // The images may not be on the machine yet (a migrated install gets its
  // refs written before anything pulled them) — a pull of an already-present
  // image is a cheap no-op.
  for (const image of [
    images.assistant,
    images.gateway,
    images["credential-executor"],
  ]) {
    log(`📦 Pulling ${image}...`);
    await pullImage(image, log);
  }

  const gatewayPort = options.gatewayPort ?? entry.port;
  const assistantPort = ASSISTANT_INTERNAL_PORT;
  const device = getOrCreateHostDeviceId();
  const runArgs = buildServiceRunArgs({
    extraAssistantEnv: {
      CADET_DEVICE_ID: device,
      ...options.extraAssistantEnv,
    },
    extraGatewayEnv: { CADET_DEVICE_ID: device, ...options.extraGatewayEnv },
    gatewayPort,
    imageTags: images,
    instanceName: entry.assistantId,
    res,
    avatarDevicePath: resolveAvatarDevicePath(),
  });
  // The assistant owns the instance's network namespace — the gateway and
  // credential-executor sidecars join it with `--network=container:` — so it
  // starts alone and the two sidecars start together (see
  // startAssistantThenSidecars).
  await startAssistantThenSidecars(runArgs, async (service) => {
    log(`Starting ${service} container...`);
    await exec("docker", runArgs[service]());
  });

  // Persist what the recreation decided (the gateway port, the assistant
  // port when it defaulted) so plain `docker start` wakes work and clients
  // reach the right endpoints.
  saveLockfileAssistant({
    ...entry,
    port: gatewayPort,
    daemonPort: entry.daemonPort ?? assistantPort,
    containerInfo: {
      ...info,
      assistantImage: images.assistant,
      gatewayImage: images.gateway,
      cesImage: images["credential-executor"],
    },
  });
}

/**
 * Start the three service containers. The assistant owns the instance's
 * network namespace — the gateway and credential-executor sidecars join it
 * with `--network=container:` — so it starts alone and the two sidecars,
 * independent of each other, start together. `docker run -d` returns once
 * the container runs, which is all a namespace join needs.
 */
async function startAssistantThenSidecars(
  runArgs: Record<ServiceName, () => string[]>,
  start: (service: ServiceName) => Promise<void>,
): Promise<void> {
  await start("assistant");
  await Promise.all([start("gateway"), start("credential-executor")]);
}

/** Start all three containers: the namespace owner first, sidecars together. */
export async function startContainers(
  opts: {
    createOnly?: boolean;
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
  await startAssistantThenSidecars(runArgs, async (service) => {
    const args = runArgs[service]();
    if (opts.createOnly) {
      args[0] = "create";
      args.splice(args.indexOf("-d"), 1);
    }
    log(`${opts.createOnly ? "Creating" : "Starting"} ${service} container...`);
    await exec("docker", args);
  });
}
