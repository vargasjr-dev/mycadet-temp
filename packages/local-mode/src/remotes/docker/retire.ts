import { exec } from "../../exec";
import { stopProcess, isCadetProcess } from "../../process";
import { DockerAssistant, isDockerEntry } from "../../lockfile-contract";
import { dockerResourceNames } from "./common";
import { sleepDocker } from "./sleep";

/** Silently attempt to stop and remove a Docker container. */
export async function removeContainer(containerName: string): Promise<void> {
  try {
    await exec("docker", ["rm", containerName]);
  } catch {
    // container may not exist or already removed
  }
}

export async function retireDocker(entry: DockerAssistant): Promise<void> {
  console.log(`\u{1F5D1}\ufe0f  Stopping Docker containers for '${name}'...\n`);

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

  const res = dockerResourceNames(entry.assistantId);

  await removeContainer(res.cesContainer);
  await removeContainer(res.gatewayContainer);
  await removeContainer(res.assistantContainer);

  // Remove network and volumes
  try {
    await exec("docker", ["network", "rm", res.network]);
  } catch {
    // network may not exist
  }
  for (const vol of [
    res.socketVolume,
    res.assistantIpcVolume,
    res.gatewayIpcVolume,
    res.workspaceVolume,
    res.cesSecurityVolume,
    res.gatewaySecurityVolume,
  ]) {
    try {
      await exec("docker", ["volume", "rm", vol]);
    } catch {
      // volume may not exist
    }
  }

  // Future: consider stopping Colima VM when no Docker instances remain.
  // Considerations:
  // - Track whether Cadet started Colima (vs. the user already had it
  //   running for non-Cadet workloads) \u2014 e.g. via a dedicated Colima
  //   profile (`colima start --profile cadet`) or a sentinel file.
  // - Only stop if both conditions are met: no cross-env Docker instances
  //   AND Cadet owns the Colima lifecycle.

  console.log(`\u2705 Docker instance retired.`);
}
