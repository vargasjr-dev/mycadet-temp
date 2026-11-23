import { execOutput } from "./exec";
import type { LockfileAssistant } from "./lockfile-contract";
import { isProcessAlive } from "./process";
import { dockerResourceNames } from "./remotes/docker/common";
import { getGatewayPidPath } from "./remotes/local/instance";

/** Whether the assistant's gateway is stopped, as `cadet sleep` leaves it. */
export async function isAssistantAsleep(
  entry: LockfileAssistant,
): Promise<boolean> {
  if (entry.cloud === "local") {
    return !isProcessAlive(getGatewayPidPath(entry)).alive;
  }
  if (entry.cloud === "docker") {
    const { gatewayContainer } = dockerResourceNames(entry.assistantId);
    const status = await execOutput("docker", [
      "container",
      "inspect",
      "--format",
      "{{.State.Status}}",
      gatewayContainer,
    ]).catch(() => "");
    return status === "exited";
  }
  return false;
}

export function assistantAsleepMessage(entry: LockfileAssistant): string {
  return `${entry.assistantId} is asleep. Run \`cadet wake ${entry.assistantId}\` first.`;
}
