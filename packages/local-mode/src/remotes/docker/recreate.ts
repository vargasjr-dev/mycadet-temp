import type { DockerAssistant } from "../../lockfile-contract";
import { exec } from "../../exec";
import { saveLockfileAssistant } from "../../lockfile";
import { getOrCreateHostDeviceId } from "../../device-id";
import { ASSISTANT_INTERNAL_PORT } from "../../ports";
import { dockerResourceNames, removeContainer } from "./retire";
import {
  buildServiceRunArgs,
  resolveAvatarDevicePath,
  type ServiceName,
} from "./statefulset";
import type { WakeResult } from "../../operations/wake";

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
