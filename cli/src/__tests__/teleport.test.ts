import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as assistants from "../lib/assistant-config.js";
import * as host from "../lib/host-teleport.js";
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
const move = spyOn(host, "teleportHostInstallation").mockResolvedValue(
  undefined,
);
const exit = spyOn(process, "exit").mockImplementation((code): never => {
  throw new Error(`exit:${code}`);
});
const errors = spyOn(console, "error").mockImplementation(() => {});
const argv = process.argv;
beforeEach(() => {
  find.mockReturnValue(entry);
  move.mockClear();
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
  move.mockRestore();
  exit.mockRestore();
  errors.mockRestore();
});
test("routes local and Docker installation moves through the host tar implementation", async () => {
  await teleport();
  expect(move).toHaveBeenCalledWith(entry, "docker", "target", {
    keepSource: true,
    dryRun: false,
  });
});
test("cloud destination refuses before starting any host operation", async () => {
  process.argv = ["bun", "cadet", "teleport", "--from", "source", "--cloud"];
  await expect(teleport()).rejects.toThrow("exit:1");
  expect(move).not.toHaveBeenCalled();
  expect(errors.mock.calls.flat().join(" ")).toContain(
    "Cloud teleport is unavailable",
  );
});
test("cloud source refuses before starting any host operation", async () => {
  find.mockReturnValue({ ...entry, cloud: "cloud" });
  await expect(teleport()).rejects.toThrow("exit:1");
  expect(move).not.toHaveBeenCalled();
});
test("same environment refuses before starting any host operation", async () => {
  find.mockReturnValue({ ...entry, cloud: "docker" });
  await expect(teleport()).rejects.toThrow("exit:1");
  expect(move).not.toHaveBeenCalled();
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
