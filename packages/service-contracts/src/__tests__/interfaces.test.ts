import { describe, expect, test } from "bun:test";
import {
  INTERFACE_IDS,
  interfaceIdSchema,
  isInterfaceId,
} from "../interfaces.js";

describe("INTERFACE_IDS", () => {
  test("covers the desktop, mobile, CLI, chat, and internal surfaces", () => {
    for (const id of [
      "macos",
      "windows",
      "linux",
      "ios",
      "android",
      "cli",
      "web",
    ] as const) {
      expect(INTERFACE_IDS).toContain(id);
    }
  });

  test("isInterfaceId accepts only canonical ids", () => {
    expect(isInterfaceId("macos")).toBe(true);
    expect(isInterfaceId("android")).toBe(true);
    expect(isInterfaceId("toaster")).toBe(false);
    expect(isInterfaceId(null)).toBe(false);
    expect(isInterfaceId(42)).toBe(false);
    // Legacy aliases are NOT canonical — the daemon's parseInterfaceId
    // normalizes them separately.
    expect(isInterfaceId("cadet")).toBe(false);
  });

  test("the zod schema accepts the same set and nothing else", () => {
    const parsed = interfaceIdSchema.safeParse("linux");
    expect(parsed.success).toBe(true);
    expect(interfaceIdSchema.safeParse("toaster").success).toBe(false);
    expect(interfaceIdSchema.safeParse(undefined).success).toBe(false);
  });

  test("the guard and the schema agree with the array", () => {
    for (const id of INTERFACE_IDS) {
      expect(isInterfaceId(id)).toBe(true);
      expect(interfaceIdSchema.safeParse(id).success).toBe(true);
    }
  });
});
