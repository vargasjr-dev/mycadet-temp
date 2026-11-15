import { exec, execOutput } from "../../exec";
import type { LockfileAssistant } from "../../lockfile-contract";
import { dockerResourceNames } from "./common";

export interface SleepDockerOptions {
  timeoutMs?: number;
  /** Progress narration (headless hosts omit it). */
  log?: (line: string) => void;
}

/**
 * The docker topology's sleep leg: stop the instance's three service
 * containers (gracefully, then remove them — the wake recreates what it
 * needs) by their derived resource names. A container that refuses to
 * stop is an error; anything already down is expected and skipped. The
 * leg narrates its own progress — the command layer adds nothing.
 */
export async function sleepDocker(
  entry: LockfileAssistant,
  options: SleepDockerOptions = {},
): Promise<void> {
  const res = dockerResourceNames(entry.assistantId);
  for (const container of [
    res.assistantContainer,
    res.gatewayContainer,
    res.cesContainer,
  ]) {
    try {
      const status = await execOutput("docker", [
        "inspect",
        "--format",
        "{{.State.Status}}",
        container,
      ]);
      if (status === "exited" || status === "created") continue;
      if (status !== "running")
        throw new Error(`${container} is ${status}; cannot stop gracefully.`);

      await exec("docker", ["stop", container]);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.toLowerCase() : String(err);
      if (msg.includes("no such container") || msg.includes("is not running")) {
        // container doesn't exist or already stopped — expected, skip
        continue;
      }
      throw err;
    }
  }
  options.log?.("Docker containers stopped.");
}
