import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as localMode from "@mycadet/local-mode";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import type { SleepResult } from "@mycadet/local-mode";
import { restart } from "../commands/restart.js";

const lookup = spyOn(localMode, "lookupAssistantByIdentifier");
const restartOp = spyOn(localMode, "restartAssistant");
const exitSpy = spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as never);

const entry: LockfileAssistant = {
  assistantId: "test",
  cloud: "local",
  port: 7830,
};

const okSleep: SleepResult = {
  ok: true,
  kind: "services",
  services: { assistant: "stopped", gateway: "stopped", ces: "stopped" },
  notes: [],
  wasRunning: true,
};

beforeEach(() => {
  for (const spy of [lookup, restartOp]) spy.mockReset();
  // mockReset restores the spy's original — re-arm the throwing exit.
  exitSpy.mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  lookup.mockReturnValue({ status: "found", entry });
  restartOp.mockResolvedValue({
    ok: true,
    reports: [{ assistantId: "test", sleep: okSleep, wake: { ok: true } }],
  });
});
afterEach(() => {
  process.argv = ["bun", "cadet", "restart"];
});
afterAll(() => {
  for (const spy of [lookup, restartOp, exitSpy]) spy.mockRestore();
});

test("restart delegates one target to the single operation", async () => {
  process.argv = ["bun", "cadet", "restart", "test"];
  await restart();
  expect(lookup).toHaveBeenCalledWith("test");
  expect(restartOp).toHaveBeenCalledWith({
    entry,
    all: false,
    log: expect.any(Function),
  });
});

test("restart --all rides the same operation with all: true", async () => {
  process.argv = ["bun", "cadet", "restart", "--all"];
  await restart();
  expect(lookup).not.toHaveBeenCalled();
  expect(restartOp).toHaveBeenCalledWith({
    entry: undefined,
    all: true,
    log: expect.any(Function),
  });
});

test("a completed restart prints one line per assistant", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  restartOp.mockResolvedValue({
    ok: true,
    reports: [
      { assistantId: "one", sleep: okSleep, wake: { ok: true } },
      { assistantId: "two", sleep: okSleep, wake: { ok: true } },
    ],
  });
  process.argv = ["bun", "cadet", "restart", "--all"];
  try {
    await restart();
    expect(log.mock.calls.some(([l]) => l === "Restarted 'one'.")).toBe(true);
    expect(log.mock.calls.some(([l]) => l === "Restarted 'two'.")).toBe(true);
  } finally {
    log.mockRestore();
  }
});

test("a failed stop surfaces the sleep error and exits 1", async () => {
  restartOp.mockResolvedValue({
    ok: false,
    reports: [
      {
        assistantId: "test",
        sleep: {
          ok: false,
          status: 500,
          error: "the process tree refused to stop",
          wasRunning: true,
        },
      },
    ],
  });
  const err = spyOn(console, "error").mockImplementation(() => {});
  process.argv = ["bun", "cadet", "restart", "test"];
  try {
    await expect(restart()).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(
      err.mock.calls.some(([l]) => String(l).includes("failed to stop 'test'")),
    ).toBe(true);
  } finally {
    err.mockRestore();
  }
});

test("a failed wake surfaces the wake error and exits 1", async () => {
  restartOp.mockResolvedValue({
    ok: false,
    reports: [
      {
        assistantId: "test",
        sleep: okSleep,
        wake: { ok: false, status: 503, error: "the gateway refused to start" },
      },
    ],
  });
  const err = spyOn(console, "error").mockImplementation(() => {});
  process.argv = ["bun", "cadet", "restart", "test"];
  try {
    await expect(restart()).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(
      err.mock.calls.some(([l]) => String(l).includes("failed to wake 'test'")),
    ).toBe(true);
  } finally {
    err.mockRestore();
  }
});

test("a cancelled drain exits 130", async () => {
  restartOp.mockResolvedValue({
    ok: false,
    reports: [
      {
        assistantId: "test",
        sleep: { ok: true, cancelled: true, wasRunning: true },
      },
    ],
  });
  process.argv = ["bun", "cadet", "restart", "test"];
  await expect(restart()).rejects.toThrow(/process\.exit/);
  expect(exitSpy).toHaveBeenCalledWith(130);
});

for (const argv of [
  ["bun", "cadet", "restart", "--all", "named"],
  ["bun", "cadet", "restart", "test", "--watch"],
  ["bun", "cadet", "restart", "test", "--force"],
  ["bun", "cadet", "restart", "test", "--repair-guardian"],
]) {
  test(`rejects ${argv.slice(3).join(" ")}`, async () => {
    process.argv = argv;
    await expect(restart()).rejects.toThrow(/process\.exit/);
    expect(restartOp).not.toHaveBeenCalled();
  });
}
