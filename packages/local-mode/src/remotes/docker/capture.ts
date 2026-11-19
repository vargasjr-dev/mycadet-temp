import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { execOutput } from "../../exec";
import { dockerResourceNames } from "./common";
import { pruneTransient, STATE_ROOTS, type StateRoot } from "../../state-roots";
import type { LockfileAssistant } from "../../lockfile-contract";

/**
 * The docker topology's capture: `docker cp` each container's persistent
 * volume out to the staging dir.
 */
export async function captureDockerRoot(
  entry: LockfileAssistant,
  target: string,
): Promise<void> {
  const names = dockerResourceNames(entry.assistantId);
  const containers: Record<StateRoot, string> = {
    workspace: names.assistantContainer,
    "gateway-security": names.gatewayContainer,
    "ces-security": names.cesContainer,
    "ces-data": names.cesContainer,
  };
  for (const stateRoot of STATE_ROOTS) {
    await mkdir(join(target, stateRoot), { mode: 0o700 });
    await execOutput(
      "docker",
      ["cp", `${containers[stateRoot]}:/${stateRoot}/.`, join(target, stateRoot)],
    );
  }
  // docker cp may retain sockets in its tar stream; remove only process artifacts.
  await pruneTransient(target);
}
