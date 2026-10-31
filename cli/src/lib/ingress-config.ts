import type { LockfileAssistant } from "@mycadet/local-mode/contract";

/** Container topologies whose gateway runs on this machine without host `resources`. */
export function isLocalContainerEntry(entry: LockfileAssistant): boolean {
  return entry.cloud === "docker" || entry.cloud === "apple-container";
}
