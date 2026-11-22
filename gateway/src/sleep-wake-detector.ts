import { getLogger } from "./logger.js";
import { getConfigFileCache } from "./config-file-cache.js";
import { getCredentials } from "./credential-cache.js";
import { getSlackSocketClient } from "./slack/lifecycle.js";
import { reconcileTelegramWebhook } from "./telegram/webhook-manager.js";

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

function handleWake(): void {
  log.info("System wake detected — reconnecting channels");

  // The Slack socket may be half-open after sleep: the server dropped it
  // but no close event ever fires.
  getSlackSocketClient()?.forceReconnect();

  // Pick up any config or credential changes made while suspended.
  getConfigFileCache().invalidate();
  getCredentials().invalidate();

  // Re-register the Telegram webhook against the current ingress URL. The
  // webhook manager owns its own readiness: without Telegram credentials
  // it skips.
  reconcileTelegramWebhook({
    credentials: getCredentials(),
    configFile: getConfigFileCache(),
  }).catch((err) => {
    log.error({ err }, "Failed to reconcile Telegram webhook after wake");
  });
}

/**
 * Starts the epoch-gap tick and returns the stop thunk, per the gateway's
 * `const stopX = startX()` lifecycle pattern. A second start replaces any
 * prior run (resetting the tick baseline), so the detector can be recycled.
 */
export function startSleepWakeDetector(
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
      handleWake();
    }
  }, intervalMs);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
