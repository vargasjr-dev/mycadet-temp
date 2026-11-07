import { join } from "node:path";

import type {
  LocalAssistant,
  LockfileAssistant,
} from "../../lockfile-contract";
import { isLocalEntry } from "../../lockfile-contract";
import { findAvailablePort, getDefaultPorts } from "../../ports";
import { isProcessAlive } from "../../process";
import { saveLockfileAssistant } from "../../lockfile";
import { healConflictedLocalPorts } from "./port-heal";
import { getDaemonPidPath } from "./instance";
import { startCes, startGateway, startLocalDaemon } from "./common";
import type { WakeResult } from "../../operations/wake";

export async function wakeLocal(
  entry: LockfileAssistant,
  opts: {
    watch?: boolean;
    /** The hatch's fresh-daemon first-boot workspace config (a temp file — CLI-internal, never a route surface). */
    defaultWorkspaceConfigPath?: string;
  } = {},
): Promise<WakeResult> {
  const { watch = false, defaultWorkspaceConfigPath } = opts;
  try {
    return await wakeLocalUnchecked(entry, {
      watch,
      defaultWorkspaceConfigPath,
    });
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
  opts: {
    watch: boolean;
    defaultWorkspaceConfigPath?: string;
  },
): Promise<WakeResult> {
  const { watch, defaultWorkspaceConfigPath } = opts;
  if (!isLocalEntry(entry)) {
    throw new WakeRefused(
      `'${entry.assistantId}' is not an on-machine assistant.`,
    );
  }

  try {
    return await wakeLocalSteps(entry, {
      watch,
      defaultWorkspaceConfigPath,
    });
  } catch (err) {
    if (err instanceof WakeRefused) {
      return { ok: false, status: 400, error: err.message };
    }
    throw err;
  }
}

async function wakeLocalSteps(
  entry: LocalAssistant,
  opts: {
    watch: boolean;
    defaultWorkspaceConfigPath?: string;
  },
): Promise<WakeResult> {
  const { watch, defaultWorkspaceConfigPath } = opts;

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

  // Simple parallel bring-up — the same shape as the Docker topology's
  // sibling containers coming up together. startCes and startGateway clear
  // their own stale processes before spawning; startLocalDaemon classifies
  // an already-running assistant internally. Readiness is the gateway's
  // responsibility: its process gates its own traffic on the daemon's
  // migrations, so an early start just means it holds the gate a little
  // longer.
  await Promise.all([
    startCes(watch, entry),
    startLocalDaemon(watch, entry, {
      defaultWorkspaceConfigPath,
    }),
    startGateway(watch, entry),
  ]);

  // A daemon that aborts during startup (an occupied runtime HTTP port, a
  // fatal subsystem failure) leaves no process behind: whatever foreign
  // listener holds the port answers the gateway's probes in its place.
  // Liveness is the one thing wake itself must answer for.
  if (!isProcessAlive(pidFile).alive) {
    throw new WakeRefused(
      `the assistant exited during startup and is not running. Its runtime HTTP port ${daemonPort} may be held by another process (check \`lsof -i :${daemonPort}\`); the daemon log records the startup error it reported.`,
    );
  }

  return { ok: true };
}

/** A deliberate per-assistant wake refusal (an unmanageable runtime). */
class WakeRefused extends Error {}
