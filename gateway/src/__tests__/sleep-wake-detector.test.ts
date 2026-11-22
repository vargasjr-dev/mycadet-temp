import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { startSleepWakeDetector } from "../sleep-wake-detector.js";

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

describe("startSleepWakeDetector", () => {
  let stopSleepWakeDetector: (() => void) | null = null;
  let onWake: ReturnType<typeof mock>;
  let originalDateNow: () => number;
  let fakeNow: number;

  beforeEach(() => {
    onWake = mock(() => {});
    originalDateNow = Date.now;
    fakeNow = 1000000;
    Date.now = () => fakeNow;
  });

  afterEach(() => {
    stopSleepWakeDetector?.();
    Date.now = originalDateNow;
  });

  test("does not fire callback on normal ticks", async () => {
    stopSleepWakeDetector = startSleepWakeDetector(onWake, 50, 2);

    // Advance time normally (within threshold)
    fakeNow += 55;
    await new Promise((r) => setTimeout(r, 70));

    expect(onWake).not.toHaveBeenCalled();
  });

  test("fires callback when elapsed time exceeds threshold", async () => {
    stopSleepWakeDetector = startSleepWakeDetector(onWake, 50, 2);

    // Wait for first tick at normal time
    await new Promise((r) => setTimeout(r, 60));

    // Simulate a sleep gap: jump time forward well past the threshold
    fakeNow += 200; // 4x the interval

    // Wait for next tick
    await new Promise((r) => setTimeout(r, 60));

    expect(onWake).toHaveBeenCalledTimes(1);
  });

  test("stop prevents further callbacks", async () => {
    const stop = startSleepWakeDetector(onWake, 50, 2);
    stop();
    stopSleepWakeDetector = stop;

    fakeNow += 500;
    await new Promise((r) => setTimeout(r, 70));

    expect(onWake).not.toHaveBeenCalled();
  });

  test("a second start resets cleanly", async () => {
    const firstStop = startSleepWakeDetector(onWake, 50, 2);
    firstStop();
    stopSleepWakeDetector = startSleepWakeDetector(onWake, 50, 2);

    // Normal tick — should not fire
    fakeNow += 55;
    await new Promise((r) => setTimeout(r, 70));

    expect(onWake).not.toHaveBeenCalled();
  });
});
