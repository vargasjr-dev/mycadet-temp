import { spawn } from "node:child_process";

import type { DockerAssistant } from "../../lockfile-contract";
import { dockerResourceNames } from "./retire";
import type { ExecLegOptions, ExecLegResult } from "../local/exec";

/**
 * The docker topology's exec leg: `docker exec` into the service's container
 * by its derived resource name. Output is inherited — the command's own
 * stdio is the UX, exactly like `docker exec` on a terminal.
 */
export async function execDocker(
  entry: DockerAssistant,
  opts: ExecLegOptions,
): Promise<ExecLegResult> {
  const names = dockerResourceNames(entry.assistantId);
  const container =
    opts.service === "gateway"
      ? names.gatewayContainer
      : opts.service === "credential-executor"
        ? names.cesContainer
        : names.assistantContainer;
  const child = spawn(
    "docker",
    ["exec", ...(opts.interactive ? ["-it"] : []), container, ...opts.command],
    { stdio: "inherit", windowsHide: true },
  );
  const code = await new Promise<number>((resolve) => {
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(127));
  });
  return code === 0 ? { ok: true, code } : { ok: false, code };
}
