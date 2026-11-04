import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as localMode from "@mycadet/local-mode";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import type { SleepResult } from "@mycadet/local-mode";
import { restart } from "../commands/restart.js";

const lookup = spyOn(localMode, "lookupAssistantByIdentifier");
const restartOp = spyOn(localMode, "restartAssistant");
const restartAllOp = spyOn(localMode, "restartAllAssistants");
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
  for (const spy of [lookup, restartOp, restartAllOp]) spy.mockReset();
  // mockReset restores the spy's original — re-arm the throwing exit.
  exitSpy.mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  lookup.mockReturnValue({ status: "found", entry });
  restartOp.mockResolvedValue({ ok: true, sleep: okSleep });
});
afterEach(() => {
  process.argv = ["bun", "cadet", "restart"];
});
afterAll(() => {
  for (const spy of [lookup, restartOp, restartAllOp, exitSpy])
    spy.mockRestore();
});

test("restart delegates to the operation with the parsed flags", async () => {
  process.argv = [
    "bun",
    "cadet",
    "restart",
    "test",
    "--force",
    "--wait",
    "90s",
    "--repair-guardian",
  ];
  await restart();
  expect(lookup).toHaveBeenCalledWith("test");
  expect(restartOp).toHaveBeenCalledWith(
    entry,
    expect.objectContaining({
      force: true,
      wait: true,
      waitMs: 90_000,
      repairGuardian: true,
    }),
  );
  expect(restartAllOp).not.toHaveBeenCalled();
});

test("restart --all rides the env-wide operation", async () => {
  restartAllOp.mockResolvedValue({ ok: true, reports: [] });
  process.argv = ["bun", "cadet", "restart", "--all"];
  await restart();
  expect(restartAllOp).toHaveBeenCalledWith(expect.objectContaining({}));
  expect(restartOp).not.toHaveBeenCalled();
});

test("a failed sleep surfaces the operation's error", async () => {
  restartOp.mockResolvedValue({
    ok: false,
    phase: "sleep",
    status: 500,
    error: "the process tree refused to stop",
  });
  process.argv = ["bun", "cadet", "restart", "test"];
  await expect(restart()).rejects.toThrow(/process\.exit/);
  expect(restartOp).toHaveBeenCalledTimes(1);
});

for (const argv of [
  ["bun", "cadet", "restart", "--all", "--repair-guardian"],
  ["bun", "cadet", "restart", "--all", "named"],
  ["bun", "cadet", "restart", "test", "--watch"],
  ["bun", "cadet", "restart", "test", "--wait=bogus"],
]) {
  test(`rejects ${argv.slice(3).join(" ")}`, async () => {
    process.argv = argv;
    await expect(restart()).rejects.toThrow(/process\.exit/);
    expect(restartOp).not.toHaveBeenCalled();
    expect(restartAllOp).not.toHaveBeenCalled();
  });
}
