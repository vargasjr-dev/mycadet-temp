import { getLogger } from "./logger.js";

const log = getLogger("sleep-wake-detector");

/**
 * Detects system sleep/wake transitions using the epoch-gap technique:
 * a periodic timer checks if the elapsed time between ticks far exceeds
 * the expected interval, which indicates the process was suspended.
 */

const SLEEP_WAKE_TICK_INTERVAL_MS = 10_000;
const SLEEP_WAKE_GAP_MULTIPLIER = 2;

let timer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;

/**
 * Starts the epoch-gap tick and returns the stop thunk, per the gateway's
 * `const stopX = startX()` lifecycle pattern. A second start replaces any
 * prior run (resetting the tick baseline), so the detector can be recycled.
 */
export function startSleepWakeDetector(
  onWake: () => void,
  intervalMs = SLEEP_WAKE_TICK_INTERVAL_MS,
  thresholdMultiplier = SLEEP_WAKE_GAP_MULTIPLIER,
): () => void {
  if (timer) clearInterval(timer);
  lastTick = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;

    if (elapsed > intervalMs * thresholdMultiplier) {
      log.info(
        { elapsedMs: elapsed, expectedMs: intervalMs },
        "System wake detected (epoch gap)",
      );
      onWake();
    }
  }, intervalMs);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
