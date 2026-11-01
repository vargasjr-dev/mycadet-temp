import { join } from "node:path";

import { resolveDataDir } from "../../config";
import { stripVersionPrefix } from "../../version";
import { DAEMON_STOP_TIMEOUT_MS } from "../../lifecycle-budgets";
import { stopProcessByPidFile, stopProcessGracefully } from "../../process";
import { getDaemonPidPath, getLocalInstanceDir } from "./instance";
import { wakeLocal } from "./wake";
import type {
  AppleContainerAssistant,
  DockerAssistant,
  LocalAssistant,
} from "../../lockfile-contract";

/**
 * Stop the assistant daemon, gateway, and CES sibling by PID file — the
 * pre-upgrade teardown shared by the upgrade and rollback flows. No-ops for
 * services with no live PID file.
 */
export async function stopLocalProcesses(
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
): Promise<void> {
  const cadetDir = entry ? getLocalInstanceDir(entry) : resolveDataDir();
  const daemonPidFile = getDaemonPidPath(entry);
  await stopProcessByPidFile(
    daemonPidFile,
    "daemon",
    undefined,
    DAEMON_STOP_TIMEOUT_MS,
    stopProcessGracefully,
  );

  const gatewayPidFile = join(cadetDir, "gateway.pid");
  await stopProcessByPidFile(
    gatewayPidFile,
    "gateway",
    undefined,
    7000,
    stopProcessGracefully,
  );

  // Stop the CES sibling if one was launched. No-op when the
  // PID file is absent.
  const cesPidFile = join(cadetDir, "ces.pid");
  await stopProcessByPidFile(
    cesPidFile,
    "credential-executor",
    undefined,
    DAEMON_STOP_TIMEOUT_MS,
    stopProcessGracefully,
  );
}

/**
 * Bring the stack back up on the freshly installed runtime through the one
 * revive seam (wake). The child processes inherit APP_VERSION so the
 * upgraded daemons report the version they now run — pinned around the wake
 * only, so nothing else in-process observes a doctored APP_VERSION.
 */
export async function restartUpgradedLocalProcesses(
  entry: LocalAssistant,
  targetVersion: string,
): Promise<void> {
  const previousAppVersion = process.env.APP_VERSION;
  process.env.APP_VERSION = stripVersionPrefix(targetVersion);
  try {
    await wakeLocal(entry);
  } finally {
    if (previousAppVersion === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = previousAppVersion;
    }
  }
}
