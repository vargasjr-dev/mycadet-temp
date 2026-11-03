import type { DockerAssistant } from "../../lockfile-contract";
import { exec } from "../../exec";
import { saveLockfileAssistant } from "../../lockfile";
import { getOrCreateHostDeviceId } from "../../device-id";
import { ASSISTANT_INTERNAL_PORT } from "../../ports";
import { dockerResourceNames } from "./retire";
import { pullImage } from "./hatch";
import { startContainers, stopContainers } from "./statefulset";

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
