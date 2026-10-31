import { join } from "path";
import { cliCommand } from "../lib/cli-name.js";

import {
  getDaemonPidPath,
  getLocalInstanceDir,
  loadAllAssistants,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import { saveLockfileAssistant, GATEWAY_PORT } from "@mycadet/local-mode";
import type { LockfileAssistant } from "../lib/assistant-config.js";
import {
  dockerResourceNames,
  isNoSuchContainerError,
  recreateDockerContainers,
  wakeContainers,
} from "../lib/docker.js";
import {
  probeDaemonReadinessWithRetry,
  waitForDaemonMigrationsReady,
} from "../lib/http-client.js";
import { healConflictedLocalPorts } from "../lib/port-heal.js";
import { yellow } from "../lib/color.js";
import {
  loadGuardianBootstrapSecret,
  saveGuardianBootstrapSecret,
} from "../lib/guardian-token.js";
import {
  DAEMON_STOP_TIMEOUT_MS,
  isProcessAlive,
  resolveProcessState,
  stopProcessByPidFile,
} from "../lib/process";
import {
  generateLocalSecret,
  isAssistantWatchModeAvailable,
  isGatewayWatchModeAvailable,
  startCes,
  startLocalDaemon,
  startGateway,
} from "../lib/local";
import { requireReadyRuntimeEntry } from "../lib/local.js";
import {
  DOCKER_GATEWAY_READY_TIMEOUT_MS,
  restoreContainerAppServer,
  restoreAppServerAndAutoTunnel,
} from "../lib/tunnel.js";

export const wake = Object.assign(
  async function wake(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} wake [<name> | --all] [options]`);
      console.log("");
      console.log("Start the assistant and gateway processes.");
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>    Name of the assistant to start, defaults to active or only local",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --all          Start every assistant across all remotes instead of one",
      );
      console.log(
        "  --watch        Run assistant and gateway in watch mode (hot reload on source changes)",
      );
      console.log(
        "  --foreground   Run assistant in foreground with logs printed to terminal",
      );
      process.exit(0);
    }

    const watch = args.includes("--watch");
    const foreground = args.includes("--foreground");
    const nameArg = args.find((a) => !a.startsWith("-"));
    const all = args.includes("--all");

    if (all && nameArg) {
      console.error("Error: --all cannot be combined with an assistant name.");
      process.exit(1);
    }
    if (all && foreground) {
      console.error("Error: --all cannot be combined with --foreground.");
      process.exit(1);
    }

    if (all) {
      await wakeAll({ watch });
      return;
    }

    const entry = resolveTargetAssistant(nameArg);
    try {
      await wakeAssistant(entry, { watch, foreground });
    } catch (err) {
      if (err instanceof WakeExit) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    // Foreground blocking is a single-assistant concern (--all refuses the
    // flag), and the docker path already warned that foreground is ignored.
    if (foreground && entry.cloud !== "docker") {
      console.log("Running in the foreground, Ctrl+C to stop...\n");
      // Block forever — the daemon is running with inherited stdio so its
      // output streams to this terminal. When the user hits Ctrl+C, SIGINT
      // propagates to the daemon child and both exit.
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
          console.log("\nShutting down...");
          resolve();
        });
        process.on("SIGTERM", () => resolve());
      });
    }
  },
  { description: "Start the assistant and gateway" },
);

/**
 * Start every assistant this CLI's environment knows about — `--all`. The
 * CLI only ever reaches one environment, so this is the current env's
 * lockfile. Same per-assistant wake as the single path, but one assistant's
 * failure never blocks the others; failures only decide the exit code.
 */
async function wakeAll(opts: { watch: boolean }): Promise<void> {
  const entries = loadAllAssistants();
  if (entries.length === 0) {
    console.error(
      `Error: no assistants found. Run '${cliCommand()} hatch' first.`,
    );
    process.exit(1);
  }

  let failures = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.assistantId)) continue;
    seen.add(entry.assistantId);
    if (entry.cloud === "apple-container") {
      console.log(
        `Skipping '${entry.assistantId}' (apple-container) — its lifecycle is managed elsewhere.`,
      );
      continue;
    }
    try {
      await wakeAssistant(entry, {
        watch: opts.watch,
        foreground: false,
      });
    } catch (err) {
      failures++;
      console.error(
        `Error: failed to wake '${entry.assistantId}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (failures > 0) {
    process.exit(1);
  }
}

type WakeAssistantOptions = {
  watch: boolean;
  foreground: boolean;
};

/**
 * Marks a deliberate per-assistant refusal (an unmanageable runtime, missing
 * resources, a daemon that died during startup). The single-assistant path
 * renders it as the same "Error: …" + exit 1 the command always printed;
 * `--all` treats it as one entry's failure and keeps waking the rest.
 */
class WakeExit extends Error {}

/**
 * Start one assistant and its gateway. Throws WakeExit on deliberate
 * refusals so the caller decides between exiting (single path) and
 * continuing to the next entry (`--all`).
 */
export async function wakeAssistant(
  entry: LockfileAssistant,
  opts: WakeAssistantOptions,
): Promise<void> {
  const { watch, foreground } = opts;

  if (entry.cloud === "docker") {
    if (watch || foreground) {
      const ignored = [watch && "--watch", foreground && "--foreground"]
        .filter(Boolean)
        .join(" and ");
      console.warn(`Warning: ${ignored} ignored for Docker instances.`);
    }
    const res = dockerResourceNames(entry.assistantId);
    try {
      await wakeContainers(res);
    } catch (err) {
      // A migrated install has data in the volumes but containers that were
      // never created (v0.0.10 run feedback: "No such container"). Recreate
      // the service group from the entry's recorded images; anything else
      // is a real wake failure.
      if (!isNoSuchContainerError(err)) throw err;
      console.log(
        `Containers for '${entry.assistantId}' don't exist yet — recreating from the recorded images...`,
      );
      await recreateDockerContainers(entry);
    }
    console.log("Docker containers started.");
    await restoreContainerAppServer(entry, DOCKER_GATEWAY_READY_TIMEOUT_MS);
    console.log("Wake complete.");
    return;
  }

  if (entry.cloud === "apple-container") {
    throw new WakeExit(
      `'${entry.assistantId}' uses the Apple Containers runtime. Its lifecycle is managed by the macOS app — use the app to start it.`,
    );
  }

  if (entry.cloud && entry.cloud !== "local") {
    throw new WakeExit(
      `'cadet wake' only works with local and docker assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
  }

  requireReadyRuntimeEntry(entry);

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
        yellow(
          `⚠️  ${entry.assistantId}: ${move.field} ${move.from} is held by another process — moved to ${move.to}.`,
        ),
      );
    }
  }

  const daemonPort = requireReadyRuntimeEntry(entry).daemonPort;
  const pidFile = getDaemonPidPath(entry);

  // Budget anchor for the migration-coordination wait below: the host
  // wrapper (packages/local-mode/src/wake.ts WAKE_TIMEOUT_MS) SIGTERMs wake
  // after 180s, and the hung-daemon health wait + post-spawn wait + gateway
  // start can already consume most of that.
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
      startLocalDaemon(watch, requireReadyRuntimeEntry(entry), { foreground }),
    ]);
    // A daemon that aborts during startup (an occupied runtime HTTP port, a
    // fatal subsystem failure) leaves no process behind, and readiness alone
    // cannot see that: whatever foreign listener holds the port answers the
    // probe in its place. Liveness is the authoritative signal, so check it
    // first and fail the command instead of reporting a successful wake for
    // an assistant that is not running.
    if (!isProcessAlive(pidFile).alive) {
      throw new WakeExit(
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

  // Restore the nginx edge and point the auto-tunnel at it. The spawned agent
  // records itself in the root lockfile under `tunnel`. Non-fatal: a down
  // edge is a degraded remote-web/webhook path, not a broken assistant.
  await restoreAppServerAndAutoTunnel(entry);

  if (daemonMigrationsFailed) {
    console.log(
      "Assistant database migrations FAILED — DB-backed routes will return 503 until the assistant is restarted. Check the daemon logs.",
    );
  } else if (daemonUnready) {
    console.log(
      "Assistant is still running database migrations; DB-backed routes return 503 until they finish.",
    );
  }
  console.log("Wake complete.");
}
