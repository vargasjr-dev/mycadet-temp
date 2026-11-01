/**
 * Background log-retention sweep (field feedback item 8 / PR 648 review).
 *
 * The prune used to run synchronously inside `initLogger`, which stretched
 * every first boot — worst on freshly-migrated assistants with a deep log
 * history — and the gateway's variant even swept on the request path (every
 * `getLogger()` call just after midnight UTC). The sweep belongs where the
 * other slow-moving hygiene work lives: the monitoring worker, off the
 * daemon's critical path entirely.
 *
 * The sweep is one readdir + stat per dated file, so the hourly cadence is
 * far more frequent than the day-granular retention cutoff needs — the
 * point is only that it never happens on the boot path. The interval is
 * unref'd so it never holds a process open.
 */

import type { LogFileConfig } from "../util/logger.js";
import { getLogger, pruneOldLogFiles } from "../util/logger.js";

const log = getLogger("log-retention-sweeper");

export interface LogRetentionSweeperHandle {
  stop(): void;
}

/** How often the background retention sweep runs. */
export const LOG_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start the recurring log-retention sweep. No-ops when no dir is configured
 * (retention itself short-circuits on `retentionDays <= 0`).
 */
export function startLogRetentionSweeper(
  config: LogFileConfig | { dir?: string; retentionDays: number },
): LogRetentionSweeperHandle {
  if (!config.dir) {
    return { stop() {} };
  }
  const dir = config.dir;
  const retentionDays = config.retentionDays;

  const sweep = () => {
    try {
      const removed = pruneOldLogFiles(dir, retentionDays);
      if (removed > 0) {
        log.info({ removed, retentionDays }, "Pruned old log files");
      }
    } catch (err) {
      log.warn({ err }, "Log retention sweep failed");
    }
  };

  const interval = setInterval(sweep, LOG_RETENTION_SWEEP_INTERVAL_MS);
  interval.unref();
  log.info(
    { dir, retentionDays, intervalMs: LOG_RETENTION_SWEEP_INTERVAL_MS },
    "Log retention sweeper started",
  );

  return {
    stop() {
      clearInterval(interval);
    },
  };
}
