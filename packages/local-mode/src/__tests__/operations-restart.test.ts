import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as sleepOps from "../operations/sleep";
import * as wakeOps from "../operations/wake";
import * as lookup from "../operations/lookup";
import type { LockfileAssistant } from "../lockfile-contract";
import type { SleepResult } from "../operations/sleep";
import { restartAssistant } from "../operations/restart";

const sleepLeg = spyOn(sleepOps, "sleepAssistant");
const wakeLeg = spyOn(wakeOps, "wakeAssistant");

const okSleep = (overrides: Partial<SleepResult> = {}): SleepResult =>
  ({
    ok: true,
    kind: "services",
    services: { assistant: "stopped", gateway: "stopped", ces: "stopped" },
    notes: [],
    wasRunning: true,
    ...overrides,
  }) as SleepResult;

beforeEach(() => {
  sleepLeg.mockReset();
  wakeLeg.mockReset();
  sleepLeg.mockResolvedValue(okSleep());
  wakeLeg.mockResolvedValue({ ok: true });
});
afterAll(() => {
  for (const spy of [sleepLeg, wakeLeg]) spy.mockRestore();
});

const entry: LockfileAssistant = {
  assistantId: "test",
  cloud: "local",
  port: 7830,
};

test("restart sleeps then wakes the same entry", async () => {
  const result = await restartAssistant({ entry });

  expect(result.ok).toBe(true);
  expect(sleepLeg).toHaveBeenCalledTimes(1);
  expect(wakeLeg).toHaveBeenCalledTimes(1);
  expect(wakeLeg).toHaveBeenCalledWith(entry);
  const [report] = result.reports;
  expect(report.assistantId).toBe("test");
  expect(report.sleep.ok).toBe(true);
  expect(report.wake?.ok).toBe(true);
  const callOrder = [
    sleepLeg.mock.calls[0]?.[0].assistantId,
    wakeLeg.mock.calls[0]?.[0].assistantId,
  ];
  expect(callOrder).toEqual(["test", "test"]);
});

test("narration reaches the sleep half", async () => {
  const lines: string[] = [];
  await restartAssistant({ entry, log: (line) => lines.push(line) });

  expect(sleepLeg).toHaveBeenCalledWith(entry, {
    log: expect.any(Function),
  });
});

test("a failed sleep never wakes the assistant", async () => {
  sleepLeg.mockResolvedValue({
    ok: false,
    status: 500,
    error: "the process tree refused to stop",
    wasRunning: true,
  });

  const result = await restartAssistant({ entry });

  expect(result.ok).toBe(false);
  expect(result.reports).toEqual([
    {
      assistantId: "test",
      sleep: {
        ok: false,
        status: 500,
        error: "the process tree refused to stop",
        wasRunning: true,
      },
    },
  ]);
  expect(wakeLeg).not.toHaveBeenCalled();
});

test("a user-cancelled drain stays stopped", async () => {
  sleepLeg.mockResolvedValue({
    ok: true,
    cancelled: true,
    wasRunning: true,
  } as SleepResult);

  const result = await restartAssistant({ entry });

  expect(result.ok).toBe(false);
  expect(result.reports[0]?.wake).toBeUndefined();
  expect(wakeLeg).not.toHaveBeenCalled();
});

test("a failed wake fails the restart but keeps the sleep report", async () => {
  wakeLeg.mockResolvedValue({
    ok: false,
    status: 503,
    error: "the gateway refused to start",
  });

  const result = await restartAssistant({ entry });

  expect(result.ok).toBe(false);
  expect(result.reports[0]?.sleep.ok).toBe(true);
  expect(result.reports[0]?.wake).toEqual({
    ok: false,
    status: 503,
    error: "the gateway refused to start",
  });
});

test("restart without an entry or all is a caller contract error", async () => {
  await expect(restartAssistant({})).rejects.toBeInstanceOf(TypeError);
});

// ---------------------------------------------------------------------------
// restart --all: handled inside the one operation
// ---------------------------------------------------------------------------

const allEntries: LockfileAssistant[] = [
  { assistantId: "one", cloud: "local", port: 7830 },
  { assistantId: "two", cloud: "docker", port: 7831 },
  {
    assistantId: "apple",
    cloud: "apple-container",
    mgmtSocket: "/tmp/apple.sock",
    port: 7832,
  },
];

test("restart --all sleeps every entry, then wakes the manageable ones", async () => {
  const all = spyOn(lookup, "loadAllAssistants").mockReturnValue(allEntries);
  try {
    const result = await restartAssistant({ all: true });

    expect(result.ok).toBe(true);
    expect(result.reports.map((r) => r.assistantId)).toEqual(["one", "two"]);
    expect(sleepLeg).toHaveBeenCalledTimes(2);
    expect(wakeLeg).toHaveBeenCalledTimes(2);
    // All sleeps run before any wake.
    const wakeIds = wakeLeg.mock.calls.map((c) => c[0].assistantId);
    expect(wakeIds).toEqual(["one", "two"]);
  } finally {
    all.mockRestore();
  }
});

test("restart --all never blocks the other assistants on one failure", async () => {
  const all = spyOn(lookup, "loadAllAssistants").mockReturnValue(allEntries);
  sleepLeg.mockImplementation(async (e: LockfileAssistant) =>
    e.assistantId === "one"
      ? ({
          ok: false,
          status: 500,
          error: "refused",
          wasRunning: true,
        } as SleepResult)
      : okSleep(),
  );
  try {
    const result = await restartAssistant({ all: true });

    expect(result.ok).toBe(false);
    const one = result.reports.find((r) => r.assistantId === "one");
    const two = result.reports.find((r) => r.assistantId === "two");
    expect(one?.wake).toBeUndefined();
    expect(two?.wake).toEqual({ ok: true });
    // The failed entry's wake never ran; the other entry's did.
    expect(wakeLeg.mock.calls.map((c) => c[0].assistantId)).toEqual(["two"]);
  } finally {
    all.mockRestore();
  }
});

test("a cancelled drain in the all sweep fails the aggregate", async () => {
  const all = spyOn(lookup, "loadAllAssistants").mockReturnValue(allEntries);
  sleepLeg.mockImplementation(async (e: LockfileAssistant) =>
    e.assistantId === "one"
      ? ({ ok: true, cancelled: true, wasRunning: true } as SleepResult)
      : okSleep(),
  );
  try {
    const result = await restartAssistant({ all: true });

    expect(result.ok).toBe(false);
    expect(
      result.reports.find((r) => r.assistantId === "one")?.wake,
    ).toBeUndefined();
    expect(wakeLeg.mock.calls.map((c) => c[0].assistantId)).toEqual(["two"]);
  } finally {
    all.mockRestore();
  }
});
