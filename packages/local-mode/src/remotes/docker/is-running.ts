import { z } from "zod";
import { execOutput } from "../../exec";
import type { DockerAssistant } from "../../lockfile-contract";
import { isNoSuchContainerError } from "./common";
import { dockerResourceNames } from "./retire";

const RunningInspectionSchema = z.object({
  State: z.object({ Status: z.string(), Running: z.boolean() }),
});
const RunningInspectionsSchema = z.array(RunningInspectionSchema).length(1);

/**
 * Whether any of a docker instance's service containers are running. A
 * never-created group (the teleport initializes the volumes before the
 * first wake) is honestly not running; a container in a state that is
 * neither created, running, nor exited refuses the check — that instance
 * needs repair before a backup/restore can reason about it.
 */
export async function isRunningDocker(
  entry: DockerAssistant,
): Promise<boolean> {
  const names = dockerResourceNames(entry.assistantId);
  const containers = [
    ...new Set([
      names.assistantContainer,
      names.gatewayContainer,
      names.cesContainer,
    ]),
  ];
  const states: Array<z.infer<typeof RunningInspectionSchema>> = [];
  for (const container of containers) {
    let inspection: z.infer<typeof RunningInspectionSchema>;
    try {
      const parsed = RunningInspectionsSchema.safeParse(
        JSON.parse(await execOutput("docker", ["inspect", container])),
      );
      if (!parsed.success) {
        throw new Error(`Invalid container inspection: ${container}`);
      }
      inspection = parsed.data[0]!;
    } catch (error) {
      if (isNoSuchContainerError(error)) return false;
      throw error;
    }
    states.push(inspection);
  }
  for (const state of states) {
    if (!["created", "running", "exited"].includes(state.State.Status)) {
      throw new Error(
        `Container is ${state.State.Status}; stop or repair it before backup/restore.`,
      );
    }
  }
  return states.some((state) => state.State.Running);
}
