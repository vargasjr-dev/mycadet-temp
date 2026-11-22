import { exec } from "../../exec";
import { stopProcess, isCadetProcess } from "../../process";
import { DockerAssistant, isDockerEntry } from "../../lockfile-contract";
import { dockerResourceNames } from "./common";
import { sleepDocker } from "./sleep";
import { DOCKER_STATEFUL_SET_SPEC } from "./statefulset";

/** Silently attempt to stop and remove a Docker container. */
export async function removeContainer(containerName: string): Promise<void> {
  try {
    await exec("docker", ["rm", containerName]);
  } catch {
    // container may not exist or already removed
  }
}

/** Remove an instance's containers, network and volumes, skipping any that are already gone. */
export async function removeDockerResources(
  assistantId: string,
): Promise<void> {
  const res = dockerResourceNames(assistantId);
  for (const container of [
    res.cesContainer,
    res.gatewayContainer,
    res.assistantContainer,
  ]) {
    await exec("docker", ["rm", "-f", container]).catch(() => {});
  }
  await exec("docker", ["network", "rm", res.network]).catch(() => {});
  for (const claim of DOCKER_STATEFUL_SET_SPEC.volumeClaimTemplates) {
    await exec("docker", [
      "volume",
      "rm",
      claim.dockerVolume(assistantId),
    ]).catch(() => {});
  }
}

export async function retireDocker(entry: DockerAssistant): Promise<void> {
  console.log(
    `\u{1F5D1}\ufe0f  Stopping Docker containers for '${entry.assistantId}'...\n`,
  );

  // Stop the file watcher process if one is tracked for this instance.
  const watcherPid =
    entry && isDockerEntry(entry) && typeof entry.watcherPid === "number"
      ? entry.watcherPid
      : null;
  if (watcherPid !== null) {
    if (isCadetProcess(watcherPid)) {
      await stopProcess(watcherPid, "file-watcher");
    } else {
      console.log(
        `PID ${watcherPid} is not a cadet process — skipping stale file-watcher PID.`,
      );
    }
  }

  await sleepDocker(entry);
  await removeDockerResources(entry.assistantId);

  // Future: consider stopping Colima VM when no Docker instances remain.
  // Considerations:
  // - Track whether Cadet started Colima (vs. the user already had it
  //   running for non-Cadet workloads) \u2014 e.g. via a dedicated Colima
  //   profile (`colima start --profile cadet`) or a sentinel file.
  // - Only stop if both conditions are met: no cross-env Docker instances
  //   AND Cadet owns the Colima lifecycle.

  console.log(`\u2705 Docker instance retired.`);
}
