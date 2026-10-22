/**
 * The post-active readiness wait shared by every managed hatch entry point.
 *
 * Once a cloud assistant is active, hold until it answers healthz: the pod
 * the hatch provisions is not always the first one up, and completing the
 * hatch onto an unreachable assistant hands the user a dead frame. Every wait
 * leaves through the healthz probe, and the caller must honour a
 * `health_timeout` outcome.
 *
 * Deliberately free of React: callers inject cancellation and timer
 * bookkeeping so the same wait runs behind a foreground screen or inside a
 * headless background hatch.
 */

import { getAssistantHealthz } from "@/assistant/api";

// Owned here: `MAX_HATCH_WAIT_MS` decides the `health_timeout` outcome below.
export const POLL_INTERVAL_MS = 3000;
export const MAX_HATCH_WAIT_MS = 300_000;

// How the readiness wait ended. `health_timeout` means the assistant never
// answered healthz within MAX_HATCH_WAIT_MS, so the hatch must be failed
// rather than completed onto an unreachable pod.
export type HatchReadinessOutcome = "ready" | "health_timeout";

export interface AwaitHatchReadinessOptions {
  assistantId: string;
  /** Epoch ms the overall hatch poll started; bounds the health wait. */
  hatchStartMs: number;
  /** Cooperative cancellation — checked before every await resumes. */
  isCancelled: () => boolean;
  /** Receives each pending poll timer (and null when it fires) so callers can clear it on unmount. */
  registerTimer?: (timer: ReturnType<typeof setTimeout> | null) => void;
}

export async function awaitHatchReadiness(
  options: AwaitHatchReadinessOptions,
): Promise<HatchReadinessOutcome> {
  const { assistantId, hatchStartMs, isCancelled, registerTimer } = options;

  // A cancelled wait resolves without scheduling anything, so the loop reaches
  // its next check with no timer left behind.
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (isCancelled()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        registerTimer?.(null);
        resolve();
      }, ms);
      registerTimer?.(timer);
    });

  while (!isCancelled()) {
    try {
      const health = await getAssistantHealthz(assistantId);
      if (health.ok) {
        return "ready";
      }
    } catch {
      // Daemon not reachable yet during the hatch.
    }
    if (Date.now() - hatchStartMs >= MAX_HATCH_WAIT_MS) {
      return "health_timeout";
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return "ready";
}
