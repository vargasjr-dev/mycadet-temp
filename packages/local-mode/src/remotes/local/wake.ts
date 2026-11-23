import { join } from "node:path";

import type {
  LocalAssistant,
  LockfileAssistant,
} from "../../lockfile-contract";
import { isLocalEntry, GATEWAY_PORT } from "../../lockfile-contract";
import { checkHealth } from "../../daemon-readiness";
import { saveLockfileAssistant } from "../../lockfile";
import { healConflictedLocalPorts } from "./port-heal";
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

  await Promise.all([
    startCes(watch, entry),
    startLocalDaemon(watch, entry),
    startGateway(watch, entry),
  ]);

  // Liveness is the one thing wake itself must answer for, and the only
  // health check the operator layer owns is the cadet's own: through its
  // gateway, which gates its traffic on the daemon's migrations. The daemon's
  // HTTP port is its bind address, never a probe target.
  const gatewayHealth = await checkHealth(entry);
  if (
    gatewayHealth.status === "unreachable" ||
    gatewayHealth.status === "timeout"
  ) {
    const gatewayPort = entry.port ?? GATEWAY_PORT;
    throw new WakeRefused(
      `the assistant's gateway did not come up. A healthy gateway is how the cadet answers — check \`lsof -i :${gatewayPort}\` and the daemon/gateway logs for the startup error they reported.`,
    );
  }

  return { ok: true };
}

/** A deliberate per-assistant wake refusal (an unmanageable runtime). */
class WakeRefused extends Error {}
