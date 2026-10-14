/**
 * Fail-loud guardian-integrity reporter (guardian-integrity-reporter.ts):
 *
 *  - First report per check emits one error log carrying the caller's detail
 *    and the failure copy.
 *  - Subsequent reports inside the hourly window are dropped (rate limit);
 *    the sibling check still reports (per-check rate limit).
 *
 * Logs are observed by mocking the logger module (a side-effect boundary —
 * the same convention as sleep-wake-detector.test.ts). Per-file CI truth:
 * the mock is process-global, so this file pins nothing else.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const errorLogs: [Record<string, unknown>, string][] = [];

mock.module("../logger.js", () => ({
  getLogger: () => ({
    error: (detail: Record<string, unknown>, msg: string) => {
      errorLogs.push([detail, msg]);
    },
    warn: () => {},
  }),
}));

await import("./test-preload.js");
const { reportGuardianMintRefused, reportMissingGuardian } =
  await import("../guardian-integrity-reporter.js");

let fakeNow = 1_000_000_000_000;

beforeEach(() => {
  errorLogs.length = 0;
  fakeNow += 24 * 60 * 60 * 1000; // start each test outside prior windows
  spyOn(Date, "now").mockImplementation(() => fakeNow);
});

describe("reportMissingGuardian", () => {
  test("first report logs one error with the detail + copy", () => {
    reportMissingGuardian({ has_contacts: true, has_actor_tokens: false });

    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0]![0]).toMatchObject({
      check: "gateway_guardian_missing",
      has_contacts: true,
      has_actor_tokens: false,
    });
    expect(errorLogs[0]![1]).toContain("until the guardian is re-seeded");
  });

  test("repeat reports inside the hourly window are dropped; the sibling check still fires", () => {
    reportMissingGuardian({});
    reportMissingGuardian({});
    reportGuardianMintRefused({ integrity_state: "ok" });

    expect(errorLogs.length).toBe(2);
    expect(errorLogs[0]![0]).toMatchObject({
      check: "gateway_guardian_missing",
    });
    expect(errorLogs[1]![0]).toMatchObject({
      check: "gateway_guardian_mint_refused",
      integrity_state: "ok",
    });
  });
});

describe("reportGuardianMintRefused", () => {
  test("first report logs one error with the detail + copy", () => {
    reportGuardianMintRefused({ integrity_state: "ok" });

    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0]![0]).toMatchObject({
      check: "gateway_guardian_mint_refused",
      integrity_state: "ok",
    });
    expect(errorLogs[0]![1]).toContain("guardian_repair_required");
  });
});
