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

import { join } from "node:path";

import type { ServiceName } from "../docker/statefulset";

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
