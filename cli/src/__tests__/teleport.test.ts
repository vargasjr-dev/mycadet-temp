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
const setActive = spyOn(assistants, "setActiveAssistant").mockImplementation(
  () => {},
);
const exit = spyOn(process, "exit").mockImplementation((code): never => {
  throw new Error(`exit:${code}`);
});
const errors = spyOn(console, "error").mockImplementation(() => {});
const argv = process.argv;
beforeEach(() => {
  find.mockReturnValue(entry);
  teleportOp.mockReset();
  setActive.mockClear();
  errors.mockClear();
  process.argv = [
    "bun",
    "cadet",
    "teleport",
    "--from",
    "source",
    "--docker",
    "target",
    "--keep-source",
  ];
});
afterEach(() => {
  process.argv = argv;
});
afterAll(() => {
  find.mockRestore();
  teleportOp.mockRestore();
  setActive.mockRestore();
  exit.mockRestore();
  errors.mockRestore();
});
test("delegates to the operation with the parsed options and activates the target", async () => {
  teleportOp.mockResolvedValue({
    ok: true,
    kind: "moved",
    sourceId: "source-1",
    targetId: "target-1",
    sourceRetired: false,
  });
  await teleport();
  expect(teleportOp).toHaveBeenCalledWith({
    source: entry,
    targetEnv: "docker",
    targetName: "target",
    keepSource: true,
    dryRun: false,
    log: expect.any(Function),
  });
  expect(setActive).toHaveBeenCalledWith("target-1");
});

test("a dry run prints the report without activating anything", async () => {
  teleportOp.mockResolvedValue({
    ok: true,
    kind: "dry-run",
    lines: ["Would move the installation roots.", "Dry run complete."],
  });
  process.argv = [
    "bun",
    "cadet",
    "teleport",
    "--from",
    "source",
    "--docker",
    "--dry-run",
  ];
  await teleport();
  expect(teleportOp).toHaveBeenCalledWith(
    expect.objectContaining({ dryRun: true }),
  );
  expect(setActive).not.toHaveBeenCalled();
});

test("an operation refusal surfaces the error and exits 1", async () => {
  teleportOp.mockResolvedValue({
    ok: false,
    status: 400,
    error: "Cannot teleport between two local assistants.",
  });
  process.argv = ["bun", "cadet", "teleport", "--from", "source", "--local"];
  await expect(teleport()).rejects.toThrow("exit:1");
  expect(errors.mock.calls.flat().join(" ")).toContain(
    "Cannot teleport between two local assistants",
  );
  expect(setActive).not.toHaveBeenCalled();
});

test("an unknown source exits before the operation runs", async () => {
  find.mockReturnValue(null);
  await expect(teleport()).rejects.toThrow("exit:1");
  expect(teleportOp).not.toHaveBeenCalled();
});

test("parses dry run and rejects multiple destinations", () => {
  expect(
    parseArgs(["--from", "source", "--local", "target", "--dry-run"]),
  ).toMatchObject({
    from: "source",
    targetEnv: "local",
    targetName: "target",
    dryRun: true,
  });
  expect(() => parseArgs(["--local", "--docker"])).toThrow("exit:1");
});
