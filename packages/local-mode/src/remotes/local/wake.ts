import { join } from "node:path";

import type {
  LocalAssistant,
  LockfileAssistant,
} from "../../lockfile-contract";
import { isLocalEntry } from "../../lockfile-contract";
import { isProcessAlive } from "../../process";
import { saveLockfileAssistant } from "../../lockfile";
import { healConflictedLocalPorts } from "./port-heal";
import { getDaemonPidPath } from "./instance";
import { startCes, startGateway, startLocalDaemon } from "./common";

import type { WakeResult } from "../../operations/wake";

export async function wakeLocal(
  entry: LockfileAssistant,
  opts: { watch?: boolean } = {},
): Promise<WakeResult> {
  const { watch = false } = opts;
  try {
    return await wakeLocalUnchecked(entry, { watch });
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
  opts: { watch: boolean },
): Promise<WakeResult> {
  const { watch } = opts;
  if (!isLocalEntry(entry)) {
    throw new WakeRefused(
      `'${entry.assistantId}' is not an on-machine assistant.`,
    );
  }

  try {
    return await wakeLocalSteps(entry, { watch });
  } catch (err) {
    if (err instanceof WakeRefused) {
      return { ok: false, status: 400, error: err.message };
    }
    throw err;
  }
}

async function wakeLocalSteps(
  entry: LocalAssistant,
  opts: { watch: boolean },
): Promise<WakeResult> {
  const { watch } = opts;

  const daemonPort =
    entry.daemonPort ?? Number(process.env.RUNTIME_HTTP_PORT || "7821");

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

  await Promise.all([
    startCes(watch, entry),
    startLocalDaemon(watch, entry),
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
