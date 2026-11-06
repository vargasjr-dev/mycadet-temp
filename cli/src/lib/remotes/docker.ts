/**
 * The docker topology's CLI-side specifics: the wake-recreate path, the
 * teleport's initialize-data half, and the pair probe. The upgrade leg
 * lives in the package's remotes/docker/upgrade.
 */
import {
  dockerResourceNames,
  pullImage,
  ensureDockerInstalled,
  getDefaultPorts,
  findOpenPort,
  resolveOwnImageRefs,
  saveLockfileAssistant,
} from "@mycadet/local-mode";
import {
  type LockfileAssistant,
} from "@mycadet/local-mode/contract";
import { initializeRootArchive } from "@mycadet/local-mode";
import { exec } from "@mycadet/local-mode";

import cliPkg from "../../../package.json";

/** The `docker start` failure for a container that was never created. */
export function isNoSuchContainerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("No such container");
}

/**
 * Initialize a fresh teleport target's docker placement WITHOUT creating
 * containers: acquire the version's images, create the network + volumes
 * (idempotently, so a retried teleport heals), record the entry, and install
 * the transferred archive into the volumes. The wake is the caller's — the
 * wake's recreate builds the containers from the entry's recorded images,
 * which is exactly the initialize-data + wake paradigm the local arm rides.
 * A hatch is just initialize-data + wake; the teleport owns both halves
 * itself and needs neither the hatch ceremony nor a container start.
 */
export async function initializeDockerTeleportTarget(
  instanceName: string,
  archive: string,
): Promise<LockfileAssistant> {
  await ensureDockerInstalled();

  // Fresh target, no namespace join: the teleport always publishes both
  // host ports. Same dynamic allocation strategy as the hatch — the
  // env-default is the preferred starting point and we walk upward on
  // collision so concurrent instances don't fight over a bind.
  const preferredGatewayPort = getDefaultPorts().gateway;
  const gatewayPort = await findOpenPort(preferredGatewayPort);
  if (gatewayPort !== preferredGatewayPort) {
    console.log(
      `Preferred gateway port ${preferredGatewayPort} is in use; allocated ${gatewayPort} for this instance.`,
    );
  }
  const preferredAssistantPort = getDefaultPorts().daemon;
  const assistantPort = await findOpenPort(preferredAssistantPort, {
    exclude: [gatewayPort],
  });
  if (assistantPort !== preferredAssistantPort) {
    console.log(
      `Preferred assistant port ${preferredAssistantPort} is in use; allocated ${assistantPort} for this instance.`,
    );
  }

  // The version-pinned images, same resolution a pull-hatch uses. The
  // archive install runs one-shot containers from these images, so they
  // must be on the machine before the data lands; the wake's recreate
  // re-pulls them as cheap no-ops.
  const imageTags = resolveOwnImageRefs(cliPkg.version);
  for (const service of [
    "assistant",
    "gateway",
    "credential-executor",
  ] as const) {
    console.log(`📦 Pulling ${imageTags[service]}...`);
    await pullImage(imageTags[service], (message) => console.log(message));
  }

  const res = dockerResourceNames(instanceName);
  console.log("📁 Creating network and volumes...");
  try {
    await exec("docker", ["network", "inspect", res.network]);
  } catch {
    await exec("docker", ["network", "create", res.network]);
  }
  for (const volume of [
    res.socketVolume,
    res.assistantIpcVolume,
    res.gatewayIpcVolume,
    res.workspaceVolume,
    res.gatewaySecurityVolume,
    res.cesSecurityVolume,
  ]) {
    try {
      await exec("docker", ["volume", "inspect", volume]);
    } catch {
      await exec("docker", ["volume", "create", volume]);
    }
  }

  // Set volume ownership so non-root containers (UID 1001) can write. The
  // state roots' ownership is set by the archive install itself (each
  // extract chowns to the destination owner); these are the runtime
  // volumes the archive never carries.
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

  const entry: LockfileAssistant = {
    assistantId: instanceName,
    port: gatewayPort,
    daemonPort: assistantPort,
    cloud: "docker",
    containerInfo: {
      assistantImage: imageTags.assistant,
      gatewayImage: imageTags.gateway,
      cesImage: imageTags["credential-executor"],
    },
  };

  // The archive lands in the volumes while nothing is up — no service
  // container is ever created here. The entry persists only after the
  // data install, mirroring the local arm's order.
  await initializeRootArchive(entry, archive);
  entry.hatchedAt = new Date().toISOString();
  saveLockfileAssistant(entry, instanceName);
  return entry;
}

