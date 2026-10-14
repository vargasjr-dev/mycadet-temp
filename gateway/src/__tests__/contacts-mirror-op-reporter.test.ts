/**
 * Fail-loud mirror-op-missing reporter (contacts-mirror-op-reporter.ts):
 *
 *  - First report per op emits one error log carrying `{ op, ...detail }`.
 *  - Repeat reports for the same op inside the hourly window are dropped; a
 *    DIFFERENT op still reports (per-op rate limit).
 *  - `isUnknownIpcMethodError` matches only the IPC server's unknown-method
 *    rejection shape.
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
const { isUnknownIpcMethodError, reportMirrorOpMissing } =
  await import("../contacts-mirror-op-reporter.js");

let fakeNow = 1_000_000_000_000;

beforeEach(() => {
  errorLogs.length = 0;
  fakeNow += 24 * 60 * 60 * 1000; // start each test outside prior windows
  spyOn(Date, "now").mockImplementation(() => fakeNow);
});

describe("reportMirrorOpMissing", () => {
  test("first report logs one error with the op + detail", () => {
    expect(() =>
      reportMirrorOpMissing("contacts_mirror_merge_contact", {
        keepId: "ct_keep",
        mergeId: "ct_merge",
      }),
    ).not.toThrow();

    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0]![0]).toMatchObject({
      op: "contacts_mirror_merge_contact",
      keepId: "ct_keep",
      mergeId: "ct_merge",
    });
    expect(errorLogs[0]![1]).toContain("divergence until the daemon updates");
  });

  test("repeat reports for the same op are dropped; a different op still fires", () => {
    reportMirrorOpMissing("contacts_mirror_merge_contact", { keepId: "a" });
    reportMirrorOpMissing("contacts_mirror_merge_contact", { keepId: "b" });
    reportMirrorOpMissing("contacts_mirror_upsert_full", { contactId: "c" });

    expect(errorLogs.length).toBe(2);
  });
});

describe("isUnknownIpcMethodError", () => {
  test("matches the IPC server's unknown-method rejection", () => {
    expect(
      isUnknownIpcMethodError(
        new Error("Unknown method: contacts_mirror_upsert_full"),
      ),
    ).toBe(true);
  });

  test("does not match other failures", () => {
    expect(isUnknownIpcMethodError(new Error("daemon unavailable"))).toBe(
      false,
    );
    expect(isUnknownIpcMethodError(new Error("Connect timed out"))).toBe(false);
    expect(isUnknownIpcMethodError("Unknown method: x")).toBe(false);
    expect(isUnknownIpcMethodError(undefined)).toBe(false);
  });
});
