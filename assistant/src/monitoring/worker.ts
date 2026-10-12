/**
 * Standalone entry point for the resource monitor as its own OS process.
 *
 * Spawned at every daemon startup (and on demand by `assistant monitoring
 * start`). Loads config, starts the sampling loop, writes a PID file, and
 * stays alive until SIGTERM/SIGINT.
 *
 * Running as a separate process — off the assistant's main event loop — is the
 * whole point: the sampler keeps recording during a main-thread freeze, and
 * its on-disk ring buffer survives the OOM SIGKILL that resets all in-VM
 * state. Periodic workspace git auto-commits also run here so large `git add`
 * / `git commit` work cannot stall the daemon event loop.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { resetDb } from "../persistence/db-connection.js";
import { disableStreamSeqStamping } from "../runtime/assistant-stream-state.js";
import { getLogger } from "../util/logger.js";
import {
  getMonitoringDataDir,
  getMonitoringPidPath,
} from "../util/platform.js";
import {
  cleanupWorkerPidFile,
  startWorkerPidFileGuard,
} from "../util/worker-process.js";
import {
  type FileDescriptorMonitorHandle,
  startFileDescriptorMonitor,
} from "./file-descriptors.js";
import { type MountWatchHandle, startMountWatch } from "./mount-watch.js";
import {
  type PluginAutoUpdateHandle,
  startPluginAutoUpdate,
} from "./plugin-auto-update.js";
import {
  type PluginSourceWatchHandle,
  startPluginSourceWatch,
} from "./plugin-source-watch.js";
import { type RecoveryHandle, startRecovery } from "./recovery/run-recovery.js";
import {
  type ResourceSamplerHandle,
  startResourceSampler,
} from "./resource-sampler.js";
import {
  startWorkspaceGitHeartbeat,
  type WorkspaceGitHeartbeatHandle,
} from "./workspace-git-heartbeat.js";

const log = getLogger("monitoring-worker");

async function main(): Promise<void> {
  // Only the daemon stamps SSE seqs and writes the shared reservation file.
  disableStreamSeqStamping();
  const config = getConfig();
  const pidPath = getMonitoringPidPath();

  // Ensure the data dir exists before the PID write — the sampler's ring buffer
  // would otherwise be the first to create it, but the PID file lands here too.
  mkdirSync(getMonitoringDataDir(), { recursive: true });

  // Write PID file so `status` and `stop` can find us.
  writeFileSync(pidPath, String(process.pid), { flag: "w" });
  log.info(
    {
      pid: process.pid,
      pidPath,
      sampleIntervalMs: config.monitoring.sampleIntervalMs,
    },
    "Resource monitor process started",
  );

  let sampler: ResourceSamplerHandle | null = null;
  let fdMonitor: FileDescriptorMonitorHandle | null = null;
  let mountWatch: MountWatchHandle | null = null;
  let sourceWatch: PluginSourceWatchHandle | null = null;
  let autoUpdate: PluginAutoUpdateHandle | null = null;
  let recovery: RecoveryHandle | null = null;
  let workspaceGitHeartbeat: WorkspaceGitHeartbeatHandle | null = null;

  let shuttingDown = false;
  let disposePidGuard: (() => void) | null = null;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "Resource monitor process shutting down");
    // Wait for in-flight git add/commit so SIGTERM does not leave index.lock.
    try {
      await workspaceGitHeartbeat?.stop();
    } catch (err) {
      log.warn({ err }, "Workspace git heartbeat shutdown failed (non-fatal)");
    }
    workspaceGitHeartbeat = null;
    recovery?.stop();
    autoUpdate?.stop();
    sourceWatch?.stop();
    mountWatch?.stop();
    fdMonitor?.stop();
    disposePidGuard?.();
    cleanupWorkerPidFile(pidPath);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Arm the identity guard before the monitoring subsystems start. Its on-arm
  // check runs synchronously, so a worker superseded during startup begins
  // shutting down here. shutdown() is async, so bail out explicitly rather
  // than fall through and start the subsystems.
  disposePidGuard = startWorkerPidFileGuard(pidPath, {
    onEvicted: (reason) => {
      log.warn(
        { reason },
        "Evicted — the PID file no longer names this worker",
      );
      void shutdown("pid-file-eviction");
    },
  });
  if (shuttingDown) {
    return;
  }

  sampler = startResourceSampler(config.monitoring);
  // Descriptor exhaustion is per-process and slow-moving, so it polls on its
  // own timer rather than riding the memory sampler's 250ms tick.
  fdMonitor = startFileDescriptorMonitor(config.monitoring);
  // Assistant-container mount table only (this process's mount namespace).
  // Warns only when /workspace, /data, or a virtiofs bind actually changes.
  mountWatch = startMountWatch(config.monitoring);
  sourceWatch = startPluginSourceWatch(
    config.monitoring.pluginSourceScanIntervalMs,
  );
  // Unattended plugin upgrades, when the workspace opted in
  // (`pluginUpdates.mode: "auto"`). The loop starts either way — the pass
  // reads the mode, so flipping it takes effect without a restart.
  autoUpdate = startPluginAutoUpdate();
  // Crash recovery runs here, off the daemon's boot path and event loop.
  recovery = startRecovery();
  // Workspace git auto-commit safety net. Turn-boundary commits stay on
  // the daemon; this timer must not run there because large `git add` /
  // `git commit` work stalls the event loop.
  workspaceGitHeartbeat = startWorkspaceGitHeartbeat();

  process.on("SIGUSR1", () => {
    log.info("Received SIGUSR1 — refreshing database connections");
    resetDb();
  });

  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception in resource monitor process");
    recovery?.stop();
    autoUpdate?.stop();
    sourceWatch?.stop();
    mountWatch?.stop();
    fdMonitor?.stop();
    sampler?.stop();
    cleanupWorkerPidFile(getMonitoringPidPath());
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection in resource monitor process");
    recovery?.stop();
    autoUpdate?.stop();
    sourceWatch?.stop();
    mountWatch?.stop();
    fdMonitor?.stop();
    sampler?.stop();
    cleanupWorkerPidFile(getMonitoringPidPath());
    process.exit(1);
  });

  process.on("exit", () => {
    recovery?.stop();
    autoUpdate?.stop();
    sourceWatch?.stop();
    mountWatch?.stop();
    fdMonitor?.stop();
    sampler?.stop();
    cleanupWorkerPidFile(getMonitoringPidPath());
  });
}

void main().catch((err) => {
  log.error({ err }, "Resource monitor process failed to start");
  cleanupWorkerPidFile(getMonitoringPidPath());
  process.exit(1);
});
