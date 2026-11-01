import { join } from "node:path";

import type {
  LocalAssistant,
  LockfileAssistant,
} from "../../lockfile-contract";
import { GATEWAY_PORT, isLocalEntry } from "../../lockfile-contract";
import { findAvailablePort, getDefaultPorts } from "../../ports";
import {
  isProcessAlive,
  resolveProcessState,
  stopProcessByPidFile,
} from "../../process";
import { DAEMON_STOP_TIMEOUT_MS } from "../../lifecycle-budgets";
import {
  probeDaemonReadinessWithRetry,
  waitForDaemonMigrationsReady,
} from "../../daemon-readiness";
import {
  loadGuardianBootstrapSecret,
  saveGuardianBootstrapSecret,
} from "../../guardian-token";
import { saveLockfileAssistant } from "../../lockfile";
import { healConflictedLocalPorts } from "./port-heal";
import { getDaemonPidPath, getLocalInstanceDir } from "./instance";
import {
  generateLocalSecret,
  isAssistantWatchModeAvailable,
  isGatewayWatchModeAvailable,
  startCes,
  startGateway,
  startLocalDaemon,
} from "./common";
import type { WakeResult } from "../../operations/wake";

export async function wakeLocal(
  entry: LockfileAssistant,
  opts: { watch?: boolean; foreground?: boolean } = {},
): Promise<WakeResult> {
  const { watch = false, foreground = false } = opts;
  try {
    return await wakeLocalUnchecked(entry, { watch, foreground });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The orchestration body. Deliberate refusals surface as thrown
 * WakeRefused (mapped to a 400 structured failure); everything else that
 * throws is a real wake failure (mapped to a 500).
 */
async function wakeLocalUnchecked(
  entry: LockfileAssistant,
  opts: { watch: boolean; foreground: boolean },
): Promise<WakeResult> {
  const { watch, foreground } = opts;
  if (!isLocalEntry(entry)) {
    throw new WakeRefused(
      `'${entry.assistantId}' is not an on-machine assistant.`,
    );
  }

  try {
    return await wakeLocalSteps(entry, { watch, foreground });
  } catch (err) {
    if (err instanceof WakeRefused) {
      return { ok: false, status: 400, error: err.message };
    }
    throw err;
  }
}

async function wakeLocalSteps(
  entry: LocalAssistant,
  opts: { watch: boolean; foreground: boolean },
): Promise<WakeResult> {
  const { watch, foreground } = opts;

  const basePorts = getDefaultPorts();
  const daemonPort = await findAvailablePort(basePorts.daemon);

  // Port auto-heal: a recorded port something else holds (a still-running
  // vellum assistant on the pre-de-clash ports, a stray listener) used to
  // kill the daemon on EADDRINUSE — or worse, leave a foreign listener
  // answering this wake's health probes. Move the entry off foreign-held
  // ports before anything binds, and say so loudly. Ports held by our own
  // processes are left for the orphan path to adopt. Local only: docker
  // ports are published by existing containers and need a recreate, which
  // the docker path below reports on its own.
  const portHeal = await healConflictedLocalPorts(entry);
  if (portHeal) {
    saveLockfileAssistant(entry);
    for (const move of portHeal.moves) {
      console.warn(
        `⚠️  ${entry.assistantId}: ${move.field} ${move.from} is held by another process — moved to ${move.to}.`,
      );
    }
  }

  const pidFile = getDaemonPidPath(entry);

  // Budget anchor for the migration-coordination wait below: the hung-daemon
  // health wait + post-spawn wait + gateway start can consume most of a
  // headless host's patience on their own.
  const wakeStartedAt = Date.now();

  let daemonRunning = false;
  let daemonUnready = false;
  let daemonMigrationsFailed = false;
  const daemonState = await resolveProcessState(
    pidFile,
    daemonPort,
    "Assistant",
    60_000,
    "readyz",
  );
  if (daemonState.status !== "needs_start") {
    if (daemonState.status === "stuck") {
      daemonRunning = true;
      daemonUnready = true;
      console.log(
        `Assistant running (pid ${daemonState.pid}) but is not responding and could not be stopped.`,
      );
    } else if (watch && isAssistantWatchModeAvailable()) {
      console.log(
        `Assistant running (pid ${daemonState.pid}) — restarting in watch mode...`,
      );
      const stopped = await stopProcessByPidFile(
        pidFile,
        "assistant",
        undefined,
        DAEMON_STOP_TIMEOUT_MS,
      );
      if (!stopped && isProcessAlive(pidFile).alive) {
        daemonRunning = true;
        daemonUnready = true;
        console.log(
          `Assistant running (pid ${daemonState.pid}) but could not be stopped for watch mode.`,
        );
      }
    } else {
      daemonRunning = true;
      daemonUnready = daemonState.status !== "healthy";
      daemonMigrationsFailed = daemonState.status === "migration_failed";
      if (watch) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) — watch mode not available, no source files. Keeping existing process.`,
        );
      } else if (daemonMigrationsFailed) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) but its database migrations failed.`,
        );
      } else if (daemonUnready) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) — database migrations still running.`,
        );
      } else {
        console.log(`Assistant already running (pid ${daemonState.pid}).`);
      }
    }
  }

  let bootstrapSecret = loadGuardianBootstrapSecret(entry.assistantId);
  let bootstrapSecretBackfilled = false;
  if (!bootstrapSecret) {
    bootstrapSecret = generateLocalSecret();
    saveGuardianBootstrapSecret(entry.assistantId, bootstrapSecret);
    bootstrapSecretBackfilled = true;
  }

  if (!daemonRunning) {
    // Spin up CES and the daemon in parallel, the way the Docker topology
    // brings its sibling containers up together — the assistant polls for the
    // CES socket during startup (discoverCesWithRetry), so it tolerates CES
    // still binding. CES's lifecycle tracks the daemon (its only consumer):
    // restarting it under a live daemon would sever the daemon's open
    // connection, so it is only (re)started alongside the daemon. startCes
    // always launches the CES sibling unconditionally.
    await Promise.all([
      startCes(watch, entry),
      startLocalDaemon(watch, entry, { foreground }),
    ]);
    // A daemon that aborts during startup (an occupied runtime HTTP port, a
    // fatal subsystem failure) leaves no process behind, and readiness alone
    // cannot see that: whatever foreign listener holds the port answers the
    // probe in its place. Liveness is the authoritative signal, so check it
    // first and fail the command instead of reporting a successful wake for
    // an assistant that is not running.
    if (!isProcessAlive(pidFile).alive) {
      throw new WakeRefused(
        `the assistant exited during startup and is not running. Its runtime HTTP port ${daemonPort} may be held by another process (check \`lsof -i :${daemonPort}\`); the daemon log records the startup error it reported.`,
      );
    }
    // startLocalDaemon's post-spawn wait is bounded (60s), and a longer
    // migration outlives it. Classify the fresh spawn the same way the
    // attach path does, so the gateway-coordination wait below applies to
    // both paths and wake's closing summary stays honest.
    const readiness = await probeDaemonReadinessWithRetry(daemonPort);
    daemonUnready = readiness === "migrating";
    daemonMigrationsFailed = readiness === "failed";
  } else {
    // Self-heal: the daemon is already healthy, but the CES sibling may have
    // died independently (crash, OOM kill). A dead ces.pid under a live daemon
    // means credential operations will fail until the next wake. Relaunch the
    // sibling so the daemon's lazy reconnect (secure-keys.ts) picks it up on
    // the next credential read. startCes always launches the sibling.
    const cadetDir = getLocalInstanceDir(entry);
    const cesPidFile = join(cadetDir, "ces.pid");
    const cesAlive = isProcessAlive(cesPidFile).alive;
    if (!cesAlive) {
      console.log("CES sibling not running — relaunching...");
      await startCes(watch, entry);
    }
  }

  // Start gateway
  let gatewayStarted = false;
  {
    const cadetDir = getLocalInstanceDir(entry);
    const gatewayPidFile = join(cadetDir, "gateway.pid");
    const gatewayState = await resolveProcessState(
      gatewayPidFile,
      entry.port ?? GATEWAY_PORT,
      "Gateway",
    );
    const gatewayAlive = gatewayState.status === "healthy";
    const gatewayStuck = gatewayState.status === "stuck";
    const restartGateway = async (
      restartWithWatch: boolean,
    ): Promise<boolean> => {
      const stopped = await stopProcessByPidFile(gatewayPidFile, "gateway");
      if (!stopped && isProcessAlive(gatewayPidFile).alive) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) but could not be stopped.`,
        );
        return false;
      }
      await startGateway(restartWithWatch, entry, {
        bootstrapSecret,
      });
      return true;
    };
    const needsRestart = bootstrapSecretBackfilled && gatewayAlive;
    if (gatewayStuck) {
      console.log(
        `Gateway running (pid ${gatewayState.pid}) but is not responding and could not be stopped.`,
      );
    } else if (needsRestart) {
      const restartWithWatch = watch && isGatewayWatchModeAvailable();
      if (restartWithWatch) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting to apply bootstrap secret...`,
        );
      } else {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting without watch mode to apply bootstrap secret...`,
        );
      }
      gatewayStarted = await restartGateway(restartWithWatch);
    } else if (gatewayAlive) {
      if (watch && isGatewayWatchModeAvailable()) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting in watch mode...`,
        );
        gatewayStarted = await restartGateway(watch);
      } else {
        if (watch) {
          console.log(
            `Gateway running (pid ${gatewayState.pid}) — watch mode not available, no source files. Keeping existing process.`,
          );
        } else {
          console.log(`Gateway already running (pid ${gatewayState.pid}).`);
        }
      }
    } else {
      await startGateway(watch, entry, { bootstrapSecret });
      gatewayStarted = true;
    }
  }

  // A freshly-(re)started gateway refuses all non-probe traffic until the
  // daemon reports migration readiness, so consumers that act right after
  // wake (the web connect-repair retry, the guardian re-provision below)
  // would hit its closed gate. When the daemon is migrating AND the gateway
  // was just started (or a guardian repair was requested), wait out the
  // migration — capped at 60s and at whatever budget remains before the
  // 180s host-wrapper SIGTERM (30s headroom kept), since earlier bounded
  // waits may already have consumed most of it. Fast path (gateway already
  // serving, no repair) stays ~1s.
  if (daemonUnready && !daemonMigrationsFailed && gatewayStarted) {
    const waitBudgetMs = Math.min(60_000, wakeStartedAt + 150_000 - Date.now());
    if (waitBudgetMs > 0) {
      const readiness = await waitForDaemonMigrationsReady(
        daemonPort,
        Date.now() + waitBudgetMs,
      );
      daemonUnready = readiness !== "ready";
      daemonMigrationsFailed = readiness === "failed";
    }
  }

  if (daemonMigrationsFailed) {
    console.log(
      "Assistant database migrations FAILED — DB-backed routes will return 503 until the assistant is restarted. Check the daemon logs.",
    );
  } else if (daemonUnready) {
    console.log(
      "Assistant is still running database migrations; DB-backed routes return 503 until they finish.",
    );
  }
  return { ok: true };
}

/** A deliberate per-assistant wake refusal (an unmanageable runtime). */
class WakeRefused extends Error {}
