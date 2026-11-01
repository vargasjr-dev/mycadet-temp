import type { LockfileAssistant } from "../../lockfile-contract";
import { exec, execOutput } from "../../exec";
import { dockerResourceNames } from "./retire";

/**
 * SIGTERM each of an instance's service containers and wait for them to
 * exit. Missing or already-stopped containers are expected and skipped; a
 * container that refuses to stop inside the timeout throws (docker
 * assistants have no escalation).
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

/**
 * The docker topology's sleep leg: stop the instance's three service
 * containers by their derived resource names.
 */
export async function sleepDocker(
  entry: LockfileAssistant,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await sleepContainers(dockerResourceNames(entry.assistantId), options);
}
