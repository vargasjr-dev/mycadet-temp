import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "pair-asleep-test-"));
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = testDir;

const actualLocalMode = await import("@mycadet/local-mode");
mock.module("@mycadet/local-mode", () => ({
  ...actualLocalMode,
  pairLocal: () => Promise.reject(new Error("gateway exited with code 1")),
}));
const { pair } = await import("../commands/pair.js");

afterAll(() => {
  mock.module("@mycadet/local-mode", () => actualLocalMode);
  if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  rmSync(testDir, { recursive: true, force: true });
});

test("a failed mint on a sleeping assistant says to wake it", async () => {
  // No gateway.pid in the instance dir, so the gateway isn't running.
  actualLocalMode.saveLockfileAssistant({
    assistantId: "nap",
    cloud: "local",
    instanceDir: join(testDir, "instance"),
  });
  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation((...a) => {
    errors.push(a.join(" "));
  });
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });

  process.argv = ["bun", "cadet", "pair", "nap"];
  await expect(pair()).rejects.toThrow("exit:1");
  errSpy.mockRestore();
  logSpy.mockRestore();
  exitSpy.mockRestore();

  expect(errors.join("\n")).toContain(
    "nap is asleep. Run `cadet wake nap` first.",
  );
});
