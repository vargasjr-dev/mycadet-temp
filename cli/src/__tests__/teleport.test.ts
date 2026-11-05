import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as assistants from "../lib/assistant-config.js";
import * as localMode from "@mycadet/local-mode";
import { parseArgs, teleport } from "../commands/teleport.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

const entry: LockfileAssistant = {
  assistantId: "source-1",
  name: "source",
  cloud: "local",
  port: 7830,
  hatchedAt: "2026-01-01T00:00:00Z",
};
const find = spyOn(assistants, "findAssistantByName");
const teleportOp = spyOn(localMode, "teleportAssistant");
const exit = spyOn(process, "exit").mockImplementation((code): never => {
  throw new Error(`exit:${code}`);
});
const errors = spyOn(console, "error").mockImplementation(() => {});
const argv = process.argv;
beforeEach(() => {
  find.mockReturnValue(entry);
  teleportOp.mockReset();
  errors.mockClear();
  process.argv = [
    "bun",
    "cadet",
    "teleport",
    "--from",
    "source",
    "--docker",
  ];
});
afterEach(() => {
  process.argv = argv;
});
afterAll(() => {
  find.mockRestore();
  teleportOp.mockRestore();
  exit.mockRestore();
  errors.mockRestore();
});
test("delegates to the operation with the parsed options", async () => {
  teleportOp.mockResolvedValue({
    ok: true,
    sourceId: "source-1",
    targetId: "source-1",
  });
  await teleport();
  expect(teleportOp).toHaveBeenCalledWith({
    source: entry,
    target: "docker",
    log: expect.any(Function),
  });
});

test("an operation refusal surfaces the error and exits 1", async () => {
  teleportOp.mockResolvedValue({
    ok: false,
    status: 400,
    error:
      "Cloud teleport is unavailable until cloud root archive transfer is supported. No installation was changed.",
  });
  process.argv = ["bun", "cadet", "teleport", "--from", "source", "--cloud"];
  await expect(teleport()).rejects.toThrow("exit:1");
  expect(errors.mock.calls.flat().join(" ")).toContain(
    "Cloud teleport is unavailable",
  );
});

test("an unknown source exits before the operation runs", async () => {
  find.mockReturnValue(null);
  await expect(teleport()).rejects.toThrow("exit:1");
  expect(teleportOp).not.toHaveBeenCalled();
});

test("parses the destination and rejects multiple destinations", () => {
  expect(parseArgs(["--from", "source", "--docker"])).toMatchObject({
    from: "source",
    targetEnv: "docker",
  });
  expect(() => parseArgs(["--local", "--docker"])).toThrow("exit:1");
});
