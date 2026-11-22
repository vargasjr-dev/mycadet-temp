import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { startSleepWakeDetector } from "../sleep-wake-detector.js";

const forceReconnect = mock(() => {});
const invalidateConfigFile = mock(() => {});
const invalidateCredentials = mock(() => {});
const reconcileTelegramWebhook = mock(() => Promise.resolve());

// Suppress logger output during tests
mock.module("../logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  initLogger: () => {},
}));

mock.module("../slack/lifecycle.js", () => ({
  getSlackSocketClient: () => ({ forceReconnect }),
}));

mock.module("../config-file-cache.js", () => ({
  getConfigFileCache: () => ({ invalidate: invalidateConfigFile }),
}));

mock.module("../credential-cache.js", () => ({
  getCredentials: () => ({ invalidate: invalidateCredentials }),
}));

mock.module("../telegram/webhook-manager.js", () => ({
  reconcileTelegramWebhook: () => reconcileTelegramWebhook(),
}));

describe("startSleepWakeDetector", () => {
  let stopSleepWakeDetector: (() => void) | null = null;
  let originalDateNow: () => number;
  let fakeNow: number;

  beforeEach(() => {
    originalDateNow = Date.now;
    fakeNow = 1000000;
    Date.now = () => fakeNow;
    forceReconnect.mockClear();
    invalidateConfigFile.mockClear();
    invalidateCredentials.mockClear();
    reconcileTelegramWebhook.mockClear();
  });

  afterEach(() => {
    stopSleepWakeDetector?.();
    Date.now = originalDateNow;
  });

  test("does not fire on normal ticks", async () => {
    stopSleepWakeDetector = startSleepWakeDetector(50, 2);

    // Advance time normally (within threshold)
    fakeNow += 55;
    await new Promise((r) => setTimeout(r, 70));

    expect(forceReconnect).not.toHaveBeenCalled();
    expect(invalidateConfigFile).not.toHaveBeenCalled();
    expect(invalidateCredentials).not.toHaveBeenCalled();
    expect(reconcileTelegramWebhook).not.toHaveBeenCalled();
  });

  test("fires the wake recovery when elapsed time exceeds threshold", async () => {
    stopSleepWakeDetector = startSleepWakeDetector(50, 2);

    // Wait for first tick at normal time
    await new Promise((r) => setTimeout(r, 60));

    // Simulate a sleep gap: jump time forward well past the threshold
    fakeNow += 200; // 4x the interval

    // Wait for next tick
    await new Promise((r) => setTimeout(r, 60));

    expect(forceReconnect).toHaveBeenCalledTimes(1);
    expect(invalidateConfigFile).toHaveBeenCalledTimes(1);
    expect(invalidateCredentials).toHaveBeenCalledTimes(1);
    expect(reconcileTelegramWebhook).toHaveBeenCalledTimes(1);
  });

  test("stop prevents further wake recoveries", async () => {
    const stop = startSleepWakeDetector(50, 2);
    stop();
    stopSleepWakeDetector = stop;

    fakeNow += 500;
    await new Promise((r) => setTimeout(r, 70));

    expect(forceReconnect).not.toHaveBeenCalled();
    expect(reconcileTelegramWebhook).not.toHaveBeenCalled();
  });

  test("a second start resets cleanly", async () => {
    const firstStop = startSleepWakeDetector(50, 2);
    firstStop();
    stopSleepWakeDetector = startSleepWakeDetector(50, 2);

    // Normal tick — should not fire
    fakeNow += 55;
    await new Promise((r) => setTimeout(r, 70));

    expect(forceReconnect).not.toHaveBeenCalled();
  });
});
