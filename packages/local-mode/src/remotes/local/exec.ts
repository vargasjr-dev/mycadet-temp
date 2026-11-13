/**
 * The local exec's service semantics — which directory a command runs in.
 * The one local instance dir carries all three services' roots (the docker
 * statefulset's per-service mounts, flattened onto one directory): the
 * assistant works in the workspace, the gateway's files live in its
 * security dir, and the credential-executor writes its data root. The CLI's
 * exec command asks this instead of inlining the mapping, so the baseten
 * wrap (whose `cadet exec` resolves the same service to the same directory
 * inside the sandbox) and the local spawn cannot drift.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { ServiceName } from "../docker/statefulset";
import type {
  ExecCommandOptions,
  ExecCommandResult,
} from "../../operations/exec";
import type { LocalAssistant } from "../../lockfile-contract";
import { applyAssistantEnvironment } from "./common";
import { getLocalInstanceDir } from "./instance";

export function localExecDirForService(
  instanceDir: string,
  service: ServiceName,
): string {
  if (service === "gateway") {
    return join(instanceDir, "gateway-security");
  }
  if (service === "credential-executor") {
    return join(instanceDir, "ces-data");
  }
  return join(instanceDir, "workspace");
}

/**
 * The local topology's exec leg: run the command on the host, in the
 * service's directory, with the instance's `bin/` shims prepended to PATH.
 * The shims are what make EVERY invocation shape — argv, compound commands,
 * pipes, shell scripts — resolve the cadet binaries to the source build the
 * daemons run instead of a globally installed published build. They are
 * best-effort here: a cadet binary that cannot resolve simply stays off the
 * PATH, and bash's own command-not-found reports it — exec never needs to
 * guess which argv element was meant to be a cadet binary.
 */
export async function execLocal(
  entry: LocalAssistant,
  opts: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const instanceDir = getLocalInstanceDir(entry);
  const serviceDir = localExecDirForService(instanceDir, opts.service);
  const workspaceDir = join(instanceDir, "workspace");
  const socketPath = join(workspaceDir, "assistant.sock");
  if (!existsSync(socketPath)) {
    return {
      ok: false,
      status: 400,
      error:
        `the assistant runtime is not reachable (no socket at ${socketPath}). ` +
        "Start it with `cadet wake`, or check `cadet ps` for its status.",
    };
  }

  const child = spawn(opts.command[0], opts.command.slice(1), {
    stdio: "inherit",
    windowsHide: true,
    cwd: serviceDir,
    env: applyAssistantEnvironment(entry),
  });
  const code = await new Promise<number>((resolve) => {
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(127));
  });
  return code === 0 ? { ok: true, code } : { ok: false, code };
}
