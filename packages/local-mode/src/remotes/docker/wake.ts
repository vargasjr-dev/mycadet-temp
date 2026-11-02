import { platform } from "node:os";

import type { DockerAssistant } from "../../lockfile-contract";
import { exec } from "../../exec";
import { dockerResourceNames } from "./retire";
import { ensureDockerDaemonRunning, isNoSuchContainerError } from "./common";
import { recreateDockerContainers } from "./recreate";
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
export async function wakeDocker(entry: DockerAssistant): Promise<WakeResult> {
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
    console.log("Docker containers started.");
    return { ok: true };
  } catch (err) {
    if (!isNoSuchContainerError(err)) {
      return {
        ok: false,
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    console.log(
      `Containers for '${entry.assistantId}' don't exist yet — recreating from the recorded images...`,
    );
    try {
      await recreateDockerContainers(entry);
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
    console.log("Docker containers started.");
    return { ok: true };
  }
}
