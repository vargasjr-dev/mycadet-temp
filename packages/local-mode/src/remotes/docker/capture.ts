import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

import { execOutput } from "../../exec";
import { dockerResourceNames } from "./common";
import { pruneTransient, STATE_ROOTS, type StateRoot } from "../../state-roots";
import type { LockfileAssistant } from "../../lockfile-contract";

/** The docker backup I/O seam (test doubles inject their own). */
export interface DockerBackupOps {
  output: typeof execOutput;
  copy: (container: string, path: string, target: string) => Promise<void>;
  install: (args: string[], source: string) => Promise<void>;
}

export const dockerOps: DockerBackupOps = {
  output: execOutput,
  copy: async (container, path, target) => {
    await execOutput("docker", ["cp", `${container}:${path}/.`, target]);
  },
  install: async (args, source) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<void>((done, fail) => {
      child.once("error", fail);
      child.once("close", (code) =>
        code === 0
          ? done()
          : fail(new Error(`Docker restore failed (${code}): ${stderr}`)),
      );
    });
    const input = tar.c({ cwd: source, portable: true }, ["."]);
    const transfer = pipeline(input, child.stdin).catch((error) => {
      child.kill("SIGTERM");
      throw error;
    });
    // Do not begin recovery while an earlier writer still owns the volume.
    const results = await Promise.allSettled([transfer, exited]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  },
};

/**
 * The docker topology's capture: `docker cp` each container's persistent
 * volume out to the staging dir.
 */
export async function captureDockerRoot(
  entry: LockfileAssistant,
  target: string,
  ops: DockerBackupOps = dockerOps,
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
    await ops.copy(
      containers[stateRoot],
      `/${stateRoot}`,
      join(target, stateRoot),
    );
  }
  // docker cp may retain sockets in its tar stream; remove only process artifacts.
  await pruneTransient(target);
}
