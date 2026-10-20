import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { getWorkspaceConfigPath } from "../../util/layout.js";
import { loadRawConfig, saveRawConfig } from "../loader.js";
import { AssistantConfigSchema } from "../schema.js";

describe("chat settings config", () => {
  test("missing settings preserve existing behavior", () => {
    const config = AssistantConfigSchema.parse({});
    expect(config.notifications.newMessageEnabled).toBe(true);
  });

  test.each([
    { notifications: { newMessageEnabled: 1 } },
    { notifications: { newMessageEnabled: null } },
    { notifications: [] },
  ])(
    "raw writes reject invalid settings before changing disk: %j",
    (invalid) => {
      const original = {
        conversations: { skipAutoRetitling: true },
        notifications: { newMessageEnabled: false },
      };
      saveRawConfig(original);
      expect(() => saveRawConfig(invalid)).toThrow();
      expect(loadRawConfig()).toEqual(original);
    },
  );

  test.each([
    { conversations: false },
    { conversations: [] },
    { conversations: null },
    { conversations: { skipAutoRetitling: "legacy" } },
    { notifications: "legacy" },
    { notifications: [] },
    { notifications: null },
    { notifications: { newMessageEnabled: "false" } },
    { notifications: { newMessageEnabled: null } },
  ])("raw unrelated writes preserve untouched legacy values: %j", (legacy) => {
    const original = { ...legacy, maxStepsPerSession: 75 };
    writeFileSync(getWorkspaceConfigPath(), JSON.stringify(original));

    const updated = { ...loadRawConfig(), maxStepsPerSession: 100 };
    saveRawConfig(updated);

    expect(loadRawConfig()).toEqual({ ...original, maxStepsPerSession: 100 });
  });

  test.each([
    [{ conversations: false }, { conversations: [] }],
    [
      { notifications: { newMessageEnabled: "false" } },
      { notifications: { newMessageEnabled: "true" } },
    ],
    [{ notifications: { newMessageEnabled: "false" } }, { notifications: [] }],
  ])("raw writes reject changed invalid values: %j -> %j", (previous, next) => {
    const configPath = getWorkspaceConfigPath();
    writeFileSync(configPath, JSON.stringify(previous));
    const originalBytes = readFileSync(configPath, "utf-8");

    expect(() => saveRawConfig(next)).toThrow();

    expect(readFileSync(configPath, "utf-8")).toBe(originalBytes);
  });

  test("raw writes can repair one leaf while preserving other legacy values", () => {
    writeFileSync(
      getWorkspaceConfigPath(),
      JSON.stringify({
        conversations: { skipAutoRetitling: "true" },
        notifications: null,
      }),
    );
    const repaired = {
      conversations: { skipAutoRetitling: true },
      notifications: null,
    };

    saveRawConfig(repaired);

    expect(loadRawConfig()).toEqual(repaired);
  });
});
