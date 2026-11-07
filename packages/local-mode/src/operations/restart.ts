import type { LockfileAssistant } from "../lockfile-contract";
import { loadAllAssistants } from "./lookup";
import { sleepAssistant, type SleepResult } from "./sleep";
import { wakeAssistant, type WakeResult } from "./wake";

/**
 * The restart OPERATION: the headless core of `cadet restart` — a sleep
 * followed by a wake of the same entry. The sleep's verdict decides the
 * wake: a failed stop never wakes (the assistant's state is unknown), and a
 * user-cancelled drain stays stopped — cancelling means "leave it running".
 * Never throws and never exits the process.
 *
 * One door for both scopes: pass `all` to restart every assistant this
 * environment's lockfile knows (all down, then all up — apple-container
 * entries are skipped, their lifecycle is managed elsewhere), or an `entry`
 * to restart one. Either way the result is a per-assistant report list so
 * the command layer narrates and exits uniformly.
 */
export interface RestartReport {
  assistantId: string;
  /** The completed (or failed) sleep half. */
  sleep: SleepResult;
  /** Present when the sleep completed and the wake ran. */
  wake?: WakeResult;
}

export type RestartAssistantResult =
  | { ok: true; reports: RestartReport[] }
  | { ok: false; reports: RestartReport[] };

export interface RestartAssistantOptions {
  /** The entry to restart — required unless `all`. */
  entry?: LockfileAssistant;
  /** Restart every assistant in this environment's lockfile. */
  all?: boolean;
  /** Progress narration for the long drain wait (headless hosts omit it). */
  log?: (line: string) => void;
}

export async function restartAssistant(
  opts: RestartAssistantOptions = {},
): Promise<RestartAssistantResult> {
  if (opts.all) return restartAll(opts);
  if (!opts.entry) {
    throw new TypeError("restartAssistant requires an entry or all: true");
  }
  const report = await restartEntry(opts.entry, opts.log);
  return {
    ok: report.sleep.ok && !report.sleep.cancelled && !!report.wake?.ok,
    reports: [report],
  };
}

/** Sleep then wake one entry — the report the command layer narrates. */
async function restartEntry(
  entry: LockfileAssistant,
  log?: (line: string) => void,
): Promise<RestartReport> {
  const sleep = await sleepAssistant(entry, { log });
  if (!sleep.ok || sleep.cancelled) {
    return { assistantId: entry.assistantId, sleep };
  }
  const wake = await wakeAssistant(entry);
  return { assistantId: entry.assistantId, sleep, wake };
}

/**
 * Every assistant down, then every assistant up: one assistant's failure
 * never blocks the others, and a failure only decides the aggregate ok.
 */
async function restartAll(
  opts: RestartAssistantOptions,
): Promise<RestartAssistantResult> {
  const entries = loadAllAssistants();
  const seen = new Set<string>();
  const manageable = entries.filter((entry) => {
    if (seen.has(entry.assistantId)) return false;
    seen.add(entry.assistantId);
    return entry.cloud !== "apple-container";
  });

  const reports: RestartReport[] = [];
  let ok = true;

  // All down first — the env-wide stop — then all up.
  const sleepResults = new Map<string, SleepResult>();
  for (const entry of manageable) {
    const sleep = await sleepAssistant(entry, { log: opts.log });
    sleepResults.set(entry.assistantId, sleep);
    if (!sleep.ok) ok = false;
  }

  for (const entry of manageable) {
    const sleep = sleepResults.get(entry.assistantId)!;
    const report: RestartReport = { assistantId: entry.assistantId, sleep };
    if (sleep.ok && !sleep.cancelled) {
      report.wake = await wakeAssistant(entry);
      if (!report.wake.ok) ok = false;
    } else {
      ok = false;
    }
    reports.push(report);
  }

  return { ok, reports };
}
