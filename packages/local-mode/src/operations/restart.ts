import type { LockfileAssistant } from "../lockfile-contract";
import { loadAllAssistants } from "./lookup";
import { sleepAssistant, type SleepResult } from "./sleep";
import {
  wakeAssistant,
  type WakeAssistantOptions,
  type WakeResult,
} from "./wake";

/**
 * The restart OPERATION: the headless core of `cadet restart` — a sleep
 * followed by a wake of the same entry. The sleep's verdict decides the
 * wake: a failed stop never wakes (the assistant's state is unknown), and a
 * user-cancelled drain (`--wait` Ctrl-C) stays stopped — cancelling means
 * "leave it running". Never throws and never exits the process.
 */
export type RestartAssistantResult =
  | {
      ok: true;
      /** The completed sleep half — the command layer narrates from it. */
      sleep: SleepResult;
    }
  | {
      ok: false;
      phase: "sleep" | "wake";
      status: number;
      error: string;
      /** Set when the sleep was cancelled by the user (exit code 130). */
      cancelled?: boolean;
      /** The sleep half's result when the wake failed (it completed). */
      sleep?: SleepResult;
    };

export interface RestartAssistantOptions {
  /** Sleep-side: stop even when a phone-call keepalive lease is active. */
  force?: boolean;
  /** Sleep-side: wait for in-flight background work before stopping. */
  wait?: boolean;
  /** Sleep-side: bound for the wait in ms; null waits as long as it takes. */
  waitMs?: number | null;
  /** Sleep-side: aborts the drain — the CLI's Ctrl-C. */
  signal?: AbortSignal;
  /** Wake-side: run assistant and gateway in watch mode. */
  watch?: boolean;
  /** Wake-side: re-provision the guardian token once the gateway serves. */
  repairGuardian?: boolean;
  /** Progress narration for the long drain wait (headless hosts omit it). */
  log?: (line: string) => void;
}

export async function restartAssistant(
  entry: LockfileAssistant,
  opts: RestartAssistantOptions = {},
): Promise<RestartAssistantResult> {
  const sleep = await sleepAssistant(entry, {
    force: opts.force,
    wait: opts.wait,
    waitMs: opts.waitMs,
    signal: opts.signal,
    log: opts.log,
  });
  if (!sleep.ok) {
    return {
      ok: false,
      phase: "sleep",
      status: sleep.status,
      error: sleep.error,
    };
  }
  if (sleep.cancelled) {
    return {
      ok: false,
      phase: "sleep",
      status: 130,
      error: "Sleep cancelled — the assistant is still running.",
      cancelled: true,
    };
  }

  const wakeOpts: WakeAssistantOptions = { watch: opts.watch };
  if (opts.repairGuardian) wakeOpts.repairGuardian = true;
  const wake = await wakeAssistant(entry, wakeOpts);
  if (!wake.ok) {
    return { ok: false, phase: "wake", status: wake.status, error: wake.error };
  }
  return { ok: true, sleep };
}

// ---------------------------------------------------------------------------
// restart --all: every assistant in this environment's lockfile
// ---------------------------------------------------------------------------

export interface RestartAllReport {
  assistantId: string;
  sleep: SleepResult;
  /** Present when the sleep completed and the wake ran. */
  wake?: WakeResult;
}

export type RestartAllResult =
  | { ok: true; reports: RestartAllReport[] }
  | { ok: false; reports: RestartAllReport[] };

/**
 * Restart every assistant this environment knows — `--all`. All assistants
 * sleep first, then all wake (the env-wide stop the sleep command performs,
 * then the env-wide start): one assistant's failure never blocks the
 * others, and the report carries each half's result for the command's
 * narration. apple-container entries are skipped — their lifecycle is
 * managed elsewhere.
 */
export async function restartAllAssistants(
  opts: RestartAssistantOptions = {},
): Promise<RestartAllResult> {
  const entries = loadAllAssistants();
  const reports: RestartAllReport[] = [];
  let ok = true;

  const seen = new Set<string>();
  const manageable = entries.filter((entry) => {
    if (seen.has(entry.assistantId)) return false;
    seen.add(entry.assistantId);
    return entry.cloud !== "apple-container";
  });

  // All down, then all up — the --all semantics the CLI has always had.
  const sleepResults = new Map<string, SleepResult>();
  for (const entry of manageable) {
    const sleep = await sleepAssistant(entry, {
      force: opts.force,
      wait: opts.wait,
      waitMs: opts.waitMs,
      signal: opts.signal,
      log: opts.log,
    });
    sleepResults.set(entry.assistantId, sleep);
    if (!sleep.ok) ok = false;
  }

  for (const entry of manageable) {
    const sleep = sleepResults.get(entry.assistantId)!;
    if (!sleep.ok || sleep.cancelled) {
      reports.push({ assistantId: entry.assistantId, sleep });
      continue;
    }
    const wakeOpts: WakeAssistantOptions = { watch: opts.watch };
    if (opts.repairGuardian) wakeOpts.repairGuardian = true;
    const wake = await wakeAssistant(entry, wakeOpts);
    if (!wake.ok) ok = false;
    reports.push({ assistantId: entry.assistantId, sleep, wake });
  }

  return ok ? { ok: true, reports } : { ok: false, reports };
}
