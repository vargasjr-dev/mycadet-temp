import { describe, expect, test } from "bun:test";

import {
  MEMORY_HIGH_ENV_VAR,
  MEMORY_MAX_ENV_VAR,
  MEMORY_PROFILE_ENV_VAR,
  assistantMemoryRunArgs,
  parseMemoryOverride,
  resolveAssistantMemorySettings,
} from "../memory-sizing.js";

const VM_TOTAL = 16 * 1024 * 1024 * 1024; // 16 GiB

describe("parseMemoryOverride", () => {
  test("parses binary suffixes", () => {
    expect(parseMemoryOverride("12Gi")).toBe(12 * 1024 ** 3);
    expect(parseMemoryOverride("512Mi")).toBe(512 * 1024 ** 2);
    expect(parseMemoryOverride("2Ki")).toBe(2048);
  });

  test("parses decimal suffixes", () => {
    expect(parseMemoryOverride("750M")).toBe(750_000_000);
    expect(parseMemoryOverride("1G")).toBe(1_000_000_000);
  });

  test("treats a bare number as bytes and floors fractions", () => {
    expect(parseMemoryOverride("1024")).toBe(1024);
    expect(parseMemoryOverride("0.5Gi")).toBe(Math.floor(0.5 * 1024 ** 3));
  });

  test("throws on garbage", () => {
    expect(() => parseMemoryOverride("recomended")).toThrow();
    expect(() => parseMemoryOverride("12GiB")).toThrow();
    expect(() => parseMemoryOverride("")).toThrow();
    expect(() => parseMemoryOverride("-5Gi")).toThrow();
  });
});

describe("resolveAssistantMemorySettings", () => {
  test("returns null when nothing is set — the default leaves the container unlimited", () => {
    expect(resolveAssistantMemorySettings({}, VM_TOTAL)).toBeNull();
  });

  test("recommended profile applies 90% max / 75% high of the daemon total", () => {
    expect(
      resolveAssistantMemorySettings(
        { [MEMORY_PROFILE_ENV_VAR]: "recommended" },
        VM_TOTAL,
      ),
    ).toEqual({
      maxBytes: Math.floor(VM_TOTAL * 0.9),
      highBytes: Math.floor(VM_TOTAL * 0.75),
    });
  });

  test("an unknown profile name fails loudly instead of silently unlimited", () => {
    expect(() =>
      resolveAssistantMemorySettings(
        { [MEMORY_PROFILE_ENV_VAR]: "recomended" },
        VM_TOTAL,
      ),
    ).toThrow(MEMORY_PROFILE_ENV_VAR);
  });

  test("a requested profile without a readable daemon total is an error, not a silent no-op", () => {
    expect(() =>
      resolveAssistantMemorySettings(
        { [MEMORY_PROFILE_ENV_VAR]: "recommended" },
        null,
      ),
    ).toThrow("could not be read");
    expect(() =>
      resolveAssistantMemorySettings(
        { [MEMORY_PROFILE_ENV_VAR]: "recommended" },
        0,
      ),
    ).toThrow("could not be read");
  });

  test("a MAX override below the default high clamps the reservation to the cap", () => {
    const max = 8 * 1024 ** 3;
    expect(
      resolveAssistantMemorySettings({ [MEMORY_MAX_ENV_VAR]: "8Gi" }, VM_TOTAL),
    ).toEqual({ maxBytes: max, highBytes: max });
  });

  test("a HIGH override only caps at the default max when it overshoots", () => {
    const high = 15 * 1024 ** 3; // above the 90% default cap
    const settings = resolveAssistantMemorySettings(
      { [MEMORY_HIGH_ENV_VAR]: "15Gi" },
      VM_TOTAL,
    );
    expect(settings).toEqual({
      maxBytes: high, // cap follows the reservation
      highBytes: high,
    });
  });

  test("HIGH override below the default max leaves the cap at 90%", () => {
    const high = 4 * 1024 ** 3;
    expect(
      resolveAssistantMemorySettings(
        { [MEMORY_HIGH_ENV_VAR]: "4Gi" },
        VM_TOTAL,
      ),
    ).toEqual({ maxBytes: Math.floor(VM_TOTAL * 0.9), highBytes: high });
  });

  test("explicit overrides win over the profile and high clamps to max", () => {
    expect(
      resolveAssistantMemorySettings(
        {
          [MEMORY_PROFILE_ENV_VAR]: "recommended",
          [MEMORY_MAX_ENV_VAR]: "4Gi",
          [MEMORY_HIGH_ENV_VAR]: "6Gi",
        },
        VM_TOTAL,
      ),
    ).toEqual({ maxBytes: 4 * 1024 ** 3, highBytes: 4 * 1024 ** 3 });
  });
});

describe("assistantMemoryRunArgs", () => {
  test("empty when sizing is off — identical to today's launch", () => {
    expect(assistantMemoryRunArgs(null)).toEqual([]);
  });

  test("flags: memory = max, reservation = high, swap pinned to memory", () => {
    const settings = { maxBytes: 14_000_000_000, highBytes: 11_000_000_000 };
    expect(assistantMemoryRunArgs(settings)).toEqual([
      "--memory",
      "14000000000",
      "--memory-reservation",
      "11000000000",
      "--memory-swap",
      "14000000000",
    ]);
  });
});
