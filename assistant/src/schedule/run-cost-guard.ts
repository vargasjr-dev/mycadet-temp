/**
 * Spending guard for one schedule run.
 *
 * Re-reads what the run has spent on LLM calls (usage rows stamped with its
 * `cron_run_id`, which includes subagents the run started) and calls
 * `onExceeded` once when the total passes the schedule's limit, so the
 * scheduler can stop the run the same way it stops one that hits its time
 * limit. The poll interval bounds how far a run can overshoot; `finish()`
 * reads the total once more after the run, so spend that landed between polls
 * is still caught.
 *
 * A failed read is logged and treated as within the limit: a usage-ledger
 * hiccup must not fail a run that is otherwise healthy.
 */

import { getUsageCostForRun } from "../persistence/llm-usage-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("run-cost-guard");

/** How often a running schedule's spend is re-read. */
export const RUN_COST_POLL_MS = 5_000;

/** Smallest limit a schedule accepts, in USD. */
export const MIN_RUN_COST_LIMIT_USD = 0.01;

export interface RunCostGuard {
  /**
   * Stop polling, check the total one last time, and return the run's spend
   * when it went over the limit, else null.
   */
  finish(): number | null;
}

export interface RunCostGuardParams {
  runId: string;
  /** The schedule's `maxRunCostUsd`; null disables the guard. */
  limitUsd: number | null;
  /** Called once, with the run's spend, when it first goes over the limit. */
  onExceeded: (costUsd: number) => void;
  pollMs?: number;
  readCostUsd?: (runId: string) => number;
}

function readRunCostUsd(runId: string): number {
  return getUsageCostForRun({ cronRunId: runId, from: 0, to: 0 });
}

export function startRunCostGuard(params: RunCostGuardParams): RunCostGuard {
  const { runId, limitUsd, onExceeded } = params;
  if (limitUsd === null) {
    return { finish: () => null };
  }
  const readCostUsd = params.readCostUsd ?? readRunCostUsd;

  let exceededUsd: number | null = null;
  const check = (): void => {
    if (exceededUsd !== null) {
      return;
    }
    let costUsd: number;
    try {
      costUsd = readCostUsd(runId);
    } catch (err) {
      log.warn({ err, runId }, "Could not read schedule run spend");
      return;
    }
    if (costUsd > limitUsd) {
      exceededUsd = costUsd;
      onExceeded(costUsd);
    }
  };

  const timer = setInterval(check, params.pollMs ?? RUN_COST_POLL_MS);

  return {
    finish() {
      clearInterval(timer);
      check();
      return exceededUsd;
    },
  };
}

/** Render a schedule's per-run spending limit for CLI and tool output. */
export function formatScheduleMaxRunCost(limitUsd: number | null): string {
  return limitUsd === null ? "no limit" : `$${limitUsd.toFixed(2)}`;
}

/**
 * Validate a requested `maxRunCostUsd`: null clears the limit, otherwise a
 * finite number of at least {@link MIN_RUN_COST_LIMIT_USD}. Returns an error
 * message naming `field` (the caller's spelling of the parameter), or null
 * when the value is acceptable.
 */
export function validateMaxRunCostUsd(
  value: unknown,
  field = "maxRunCostUsd",
): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < MIN_RUN_COST_LIMIT_USD
  ) {
    return `${field} must be null or a number of at least ${MIN_RUN_COST_LIMIT_USD}`;
  }
  return null;
}
