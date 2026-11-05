import type { LockfileAssistant } from "../../lockfile-contract";
import { exec, execOutput } from "../../exec";
import { dockerResourceNames, removeContainer } from "./retire";

/**
 * SIGTERM each of an instance's service containers, wait for them to exit,
 * then remove them — the wake recreates what it needs (containers hold no
 * state; the volumes do). Missing or already-stopped containers are
 * expected and skipped; a container that refuses to stop inside the timeout
 * throws (docker assistants have no escalation).
 *
 * Private stop primitive — consumers go through `sleepDocker`, which
 * derives the resource names from the entry.
 */
async function sleepContainers(
  res: ReturnType<typeof dockerResourceNames>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
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
      await exec("docker", ["kill", "--signal=SIGTERM", container]);
      const deadline = Date.now() + (options.timeoutMs ?? 60_000);
      while (
        (await execOutput("docker", [
          "inspect",
          "--format",
          "{{.State.Running}}",
          container,
        ])) === "true"
      ) {
        if (Date.now() >= deadline)
          throw new Error(`${container} did not stop gracefully.`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await removeContainer(container);
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
}

export interface SleepDockerOptions {
  timeoutMs?: number;
  /** Sleep-side wait is not supported for docker yet — narrate when asked. */
  wait?: boolean;
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
  if (options.wait) {
    options.log?.(
      "--wait is not supported for Docker assistants yet — stopping containers now.",
    );
  }
  await sleepContainers(dockerResourceNames(entry.assistantId), options);
  options.log?.("Docker containers stopped.");
}
