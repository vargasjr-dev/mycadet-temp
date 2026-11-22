import { describe, expect, mock, test } from "bun:test";

let cleanupCalls = 0;
let failEveryNth = 0;

// The scheduler's only dependency is the store's sweep; mocking it keeps the
// test about the wiring — tick, report, survive a failed sweep, stop.
mock.module("../db/inbound-dedup-store.js", () => ({
  cleanupExpiredInboundEvents: () => {
    cleanupCalls += 1;
    if (failEveryNth > 0 && cleanupCalls % failEveryNth === 0) {
      throw new Error("simulated sweep failure");
    }
    return 2;
  },
}));

const { startInboundEventExpirationCleanup } =
  await import("./inbound-event.js");

describe("startInboundEventExpirationCleanup", () => {
  test("sweeps on the interval and stops when told", async () => {
    cleanupCalls = 0;
    failEveryNth = 0;

    const stop = startInboundEventExpirationCleanup(20);
    try {
      await Bun.sleep(70);
      const swept = cleanupCalls;
      expect(swept).toBeGreaterThanOrEqual(2);

      stop();
      const afterStop = cleanupCalls;
      await Bun.sleep(60);
      expect(cleanupCalls).toBe(afterStop);
    } finally {
      stop();
    }
  });

  test("a failed sweep does not stop the scheduler", async () => {
    cleanupCalls = 0;
    failEveryNth = 2;

    const stop = startInboundEventExpirationCleanup(20);
    try {
      await Bun.sleep(90);
      // Half the sweeps threw; the interval kept ticking anyway.
      expect(cleanupCalls).toBeGreaterThanOrEqual(3);
    } finally {
      stop();
    }
  });
});
