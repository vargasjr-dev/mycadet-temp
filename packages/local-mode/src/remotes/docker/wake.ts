import { platform } from "node:os";

import type { LockfileAssistant } from "../../lockfile-contract";
import { cliCommand } from "../../environment";
import { exec } from "../../exec";
import { dockerResourceNames } from "./retire";
import { ensureDockerDaemonRunning, isNoSuchContainerError } from "./common";
import type { WakeResult } from "../../operations/wake";

/**
 * The docker topology's wake leg: start the instance's three service
 * containers by their derived resource names. On macOS the Docker daemon is
 * brought up first (Colima fallback) — a slept assistant on a rebooted Mac
 * must wake without a manual `colima start`.
 *
 * Never throws: a container that was never created (a migrated install with
 * data in the volumes but no containers) answers 404 pointing at the CLI's
 * recreate; every other failure is a 500 carrying the docker error.
 */
export async function wakeDocker(
  entry: LockfileAssistant,
): Promise<WakeResult> {
  try {
    const res = dockerResourceNames(entry.assistantId);
    if (platform() !== "linux") {
      await ensureDockerDaemonRunning();
    }
    for (const container of [
      res.assistantContainer,
      res.gatewayContainer,
      res.cesContainer,
    ]) {
      await exec("docker", ["start", container]);
    }
    return { ok: true };
  } catch (err) {
    if (isNoSuchContainerError(err)) {
      // A migrated install has data in the volumes but containers that
      // were never created. The recreate needs the container-create
      // builder (images, ports, volumes, the bootstrap secret), which
      // still lives CLI-side — the honest answer points at it.
      return {
        ok: false,
        status: 404,
        error: `the containers for '${entry.assistantId}' don't exist yet — run \`cadet wake\` once to recreate them from the recorded images`,
      };
    }
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
