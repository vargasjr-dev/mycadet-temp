import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as assistantConfig from "../lib/assistant-config.js";
import * as lifecycle from "../lib/upgrade-lifecycle.js";
import * as cloudClient from "../lib/cloud-client.js";
import { rollback } from "../commands/rollback.js";

const entry: assistantConfig.AssistantEntry = {
  assistantId: "docker-assistant",
  cloud: "docker",
  runtimeUrl: "http://127.0.0.1:7830",
  previousVersion: "v0.8.11",
};

let originalArgv: string[];
let performRollback: ReturnType<
  typeof spyOn<typeof lifecycle, "performDockerRollback">
>;
let previousVersion: ReturnType<
  typeof spyOn<typeof lifecycle, "fetchPreviousVersion">
>;
let currentVersion: ReturnType<
  typeof spyOn<typeof lifecycle, "fetchCurrentVersion">
>;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  originalArgv = process.argv;
  process.argv = ["bun", "cadet", "rollback", entry.assistantId];
  spies.push(spyOn(console, "log").mockImplementation(() => {}));
  spies.push(spyOn(console, "error").mockImplementation(() => {}));
  spies.push(
    spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    }),
  );
  spies.push(
    spyOn(assistantConfig, "findAssistantByName").mockReturnValue({ ...entry }),
  );
  performRollback = spyOn(
    lifecycle,
    "performDockerRollback",
  ).mockResolvedValue();
  previousVersion = spyOn(lifecycle, "fetchPreviousVersion").mockResolvedValue(
    "v0.8.11",
  );
  currentVersion = spyOn(lifecycle, "fetchCurrentVersion").mockResolvedValue(
    "v0.8.12",
  );
  spies.push(performRollback, previousVersion, currentVersion);
  spies.push(spyOn(lifecycle, "broadcastUpgradeEvent").mockResolvedValue());
});

afterEach(() => {
  process.argv = originalArgv;
  for (const spy of spies.splice(0).reverse()) {
    spy.mockRestore();
  }
});

describe("rollback", () => {
  test("uses the version-based lifecycle without saved container or migration state", async () => {
    await rollback();
    expect(previousVersion).toHaveBeenCalledWith("v0.8.12", "v0.8.11");
    expect(performRollback).toHaveBeenCalledWith(entry, {
      targetVersion: "v0.8.11",
    });
  });

  test("an explicit version bypasses default target lookup", async () => {
    process.argv.push("--version", "v0.8.10");
    await rollback();
    expect(previousVersion).not.toHaveBeenCalled();
    expect(currentVersion).not.toHaveBeenCalled();
    expect(performRollback).toHaveBeenCalledWith(entry, {
      targetVersion: "v0.8.10",
    });
  });

  test("falls back to release lookup when no previous version was recorded", async () => {
    const { previousVersion: _, ...uncachedEntry } = entry;
    spies.push(
      spyOn(assistantConfig, "findAssistantByName").mockReturnValue(
        uncachedEntry,
      ),
    );
    previousVersion.mockResolvedValue("v0.8.9");
    await rollback();
    expect(previousVersion).toHaveBeenCalledWith("v0.8.12", undefined);
    expect(performRollback).toHaveBeenCalledWith(uncachedEntry, {
      targetVersion: "v0.8.9",
    });
  });

  test("refuses before changing containers when no target is available", async () => {
    previousVersion.mockResolvedValue(undefined);
    await expect(rollback()).rejects.toThrow("exit");
    expect(performRollback).not.toHaveBeenCalled();
  });

  test("reports a lifecycle failure", async () => {
    performRollback.mockRejectedValue(new Error("image pull failed"));
    await expect(rollback()).rejects.toThrow("exit");
    expect(lifecycle.broadcastUpgradeEvent).toHaveBeenCalledWith(
      entry.runtimeUrl,
      entry.assistantId,
      lifecycle.buildCompleteEvent("v0.8.11", false),
    );
  });

  test("managed assistants still use the cloud rollback endpoint", async () => {
    spies.push(
      spyOn(assistantConfig, "findAssistantByName").mockReturnValue({
        ...entry,
        cloud: "cadet",
      }),
    );
    spies.push(
      spyOn(cloudClient, "readCloudToken").mockReturnValue("test-token"),
    );
    const cloudRollback = spyOn(
      cloudClient,
      "rollbackCloudAssistant",
    ).mockResolvedValue({ detail: "ok", version: "v0.8.11" });
    spies.push(cloudRollback);
    await rollback();
    expect(cloudRollback).toHaveBeenCalled();
    expect(performRollback).not.toHaveBeenCalled();
  });
});
