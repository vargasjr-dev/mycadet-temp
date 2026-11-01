import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { cliCommand } from "../../environment";
import { getGatewayUrl } from "../../lockfile-contract";
import {
  isProcessAlive,
  stopProcessByPidFile,
  stopProcessGracefully,
} from "../../process";
import { DAEMON_STOP_TIMEOUT_MS } from "../../lifecycle-budgets";
import { getLocalInstanceDir, getDaemonPidPath } from "./instance";
import { drainAssistant, type DrainOutcome } from "./drain";
import {
  loadGuardianToken,
  getGuardianAccessToken,
} from "../../guardian-token";
import type { LockfileAssistant } from "../../lockfile-contract";

const ACTIVE_CALL_LEASES_FILE = "active-call-leases.json";

type ActiveCallLease = {
  callSessionId: string;
};

function readActiveCallLeases(cadetDir: string): ActiveCallLease[] {
  const path = join(cadetDir, ACTIVE_CALL_LEASES_FILE);
  if (!existsSync(path)) {
    return [];
  }

  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    version?: number;
    leases?: Array<{ callSessionId?: unknown }>;
  };
  if (raw.version !== 1 || !Array.isArray(raw.leases)) {
    throw new Error(`Invalid active call lease file at ${path}`);
  }

  return raw.leases.filter(
    (lease): lease is ActiveCallLease =>
      typeof lease?.callSessionId === "string" &&
      lease.callSessionId.length > 0,
  );
}

/** Whether one tracked local service was stopped or was never running. */
export type SleepServiceStop = "stopped" | "not-running";

export interface SleepLocalOptions {
  force?: boolean;
  wait?: boolean;
  waitMs?: number | null;
  /** Aborts the drain phase — the CLI's Ctrl-C. */
  signal?: AbortSignal;
  /** Progress narration for the long drain wait (headless hosts omit it). */
  log?: (line: string) => void;
}

/**
 * The local topology's sleep leg: wait for in-flight background work when
 * asked, then stop the assistant daemon, the gateway, and the CES sibling
 * by PID file. Before stopping, an active phone-call keepalive lease
 * refuses the sleep — calls in flight must not be killed mid-conversation —
 * unless `force` overrides it.
 *
 * Never throws: every failure (lease conflict, windows shutdown, failed
 * graceful stop) comes back structured so the CLI's exit-code UX and the
 * operation route's wire mapping render the same detail.
 */
export async function sleepLocal(
  entry: LockfileAssistant,
  options: SleepLocalOptions = {},
): Promise<
  | {
      ok: true;
      kind: "services";
      services: Record<"assistant" | "gateway" | "ces", SleepServiceStop>;
      notes: string[];
    }
  | { ok: true; cancelled: true }
  | { ok: false; status: number; error: string }
> {
  const { force = false, wait = false, waitMs = null } = options;

  if (process.platform === "win32") {
    return {
      ok: false,
      status: 400,
      error:
        "Graceful-only shutdown is not supported for Windows local services.",
    };
  }

  const assistantPidFile = getDaemonPidPath(entry);
  const cadetDir = getLocalInstanceDir(entry);
  const gatewayPidFile = join(cadetDir, "gateway.pid");

  if (!force) {
    const assistantAlive = isProcessAlive(assistantPidFile).alive;
    if (assistantAlive) {
      let leases: ActiveCallLease[];
      try {
        leases = readActiveCallLeases(cadetDir);
      } catch (err) {
        return {
          ok: false,
          status: 409,
          error: `${
            err instanceof Error ? err.message : String(err)
          }. Use '${cliCommand()} sleep --force' to override if you want to stop the assistant anyway.`,
        };
      }
      if (leases.length > 0) {
        const activeIds = leases.map((lease) => lease.callSessionId);
        return {
          ok: false,
          status: 409,
          error: `assistant is staying awake for active phone calls (${activeIds.join(
            ", ",
          )}). Use '${cliCommand()} sleep --force' to stop it anyway.`,
        };
      }
    }
  }

  const notes: string[] = [];

  if (wait) {
    const outcome = await runDrainPhase(entry, assistantPidFile, waitMs, {
      signal: options.signal,
      log: options.log,
      notes,
    });
    if (outcome === "cancelled") {
      return { ok: true, cancelled: true };
    }
  }

  const services: Record<"assistant" | "gateway" | "ces", SleepServiceStop> = {
    assistant: (await stopProcessByPidFile(
      assistantPidFile,
      "assistant",
      undefined,
      DAEMON_STOP_TIMEOUT_MS,
      stopProcessGracefully,
    ))
      ? "stopped"
      : "not-running",
    gateway: (await stopProcessByPidFile(
      gatewayPidFile,
      "gateway",
      undefined,
      // The gateway has a configurable drain window (5s) before it exits.
      7000,
      stopProcessGracefully,
    ))
      ? "stopped"
      : "not-running",
    ces: "not-running",
  };

  // Stop the CES sibling — it is stopped by its PID file, a no-op when the
  // PID file is absent (e.g. the sibling was never started or already exited).
  const cesPidFile = join(cadetDir, "ces.pid");
  services.ces = (await stopProcessByPidFile(
    cesPidFile,
    "credential-executor",
    undefined,
    DAEMON_STOP_TIMEOUT_MS,
    stopProcessGracefully,
  ))
    ? "stopped"
    : "not-running";

  return { ok: true, kind: "services", services, notes };
}

/**
 * Wait for the assistant's in-flight background work (heartbeats, memory
 * jobs, schedule runs, active conversation turns) to finish before the stop.
 * Every failure mode falls back to a normal stop with a note — a drain must
 * never make sleep less reliable than it is without `--wait`.
 */
async function runDrainPhase(
  entry: LockfileAssistant,
  assistantPidFile: string,
  waitMs: number | null,
  io: {
    signal?: AbortSignal;
    log?: (line: string) => void;
    notes: string[];
  },
): Promise<DrainOutcome | "skipped"> {
  if (!isProcessAlive(assistantPidFile).alive) {
    return "skipped";
  }
  const baseUrl = getGatewayUrl(entry);
  const stored = loadGuardianToken(entry.assistantId)?.accessToken;
  if (!baseUrl || !stored) {
    io.notes.push(
      "Cannot reach the assistant API to wait for background work (missing URL or guardian token) — stopping without waiting.",
    );
    return "skipped";
  }
  // A token past its renewal point would 401 and read as "unreachable",
  // silently skipping the wait — resolve through the shared seam, which
  // refreshes a due token against the entry's trusted URL.
  const leased = await getGuardianAccessToken(entry.assistantId);
  if (!leased.ok) {
    io.notes.push(
      "Cannot reach the assistant API to wait for background work (missing URL or guardian token) — stopping without waiting.",
    );
    return "skipped";
  }

  io.log?.(
    waitMs == null
      ? "Waiting for the assistant to finish background work (Ctrl-C cancels)…"
      : `Waiting up to ${Math.round(waitMs / 1000)}s for the assistant to finish background work (Ctrl-C cancels)…`,
  );

  const outcome = await drainAssistant({
    baseUrl,
    token: leased.accessToken,
    deadlineAt: waitMs == null ? null : Date.now() + waitMs,
    signal: io.signal,
    log: io.log,
  });
  switch (outcome) {
    case "drained":
      io.log?.("Background work finished — stopping now.");
      break;
    case "timeout":
      io.log?.(
        "Wait limit reached — stopping now. Interrupted background jobs resume after the next start.",
      );
      break;
    case "unsupported":
      io.notes.push(
        "This assistant version does not support --wait — stopping without waiting.",
      );
      break;
    case "unreachable":
      io.notes.push(
        "Could not reach the assistant to check background work — stopping without waiting.",
      );
      break;
    case "cancelled":
      break;
  }
  return outcome;
}
