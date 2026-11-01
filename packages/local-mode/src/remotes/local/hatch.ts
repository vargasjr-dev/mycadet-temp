import {
  startCes,
  startGateway,
  startLocalDaemon,
} from "./common";
import type { LocalAssistant } from "../../lockfile-contract";

/**
 * The local hatch leg's process startup: launch the CES sibling alongside
 * the daemon in parallel (matching the Docker topology — the assistant does
 * not spawn its own CES, so a freshly hatched instance would otherwise come
 * up with CES unavailable), then start the gateway once the daemon is ready.
 *
 * Throws when either parallel arm rejects so the CLI's hatch flow can stop
 * the partial stack and report. The start primitives stay private to the
 * local lifecycle legs — callers converge on the operations.
 */
export async function hatchLocalProcesses(
  entry: LocalAssistant,
  opts: { watch?: boolean; defaultWorkspaceConfigPath?: string } = {},
): Promise<void> {
  const { watch = false, defaultWorkspaceConfigPath } = opts;
  // Launch the CES sibling alongside the daemon, in parallel — matching the
  // Docker topology. startCes always launches the CES sibling.
  const startupResults = await Promise.allSettled([
    startCes(watch, entry),
    startLocalDaemon(watch, entry, {
      defaultWorkspaceConfigPath,
      requireReady: true,
    }),
  ]);
  const startupFailure = startupResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (startupFailure) {
    throw startupFailure.reason;
  }

  await startGateway(watch, entry, {
    requireReady: true,
  });
}
