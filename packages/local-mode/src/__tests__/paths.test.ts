import { describe, expect, test } from "bun:test";

import {
  assertSafePathSegment,
  joinLocalPath,
  resolveConfigHome,
  resolveConfigHomes,
  resolveDataHome,
} from "../paths";

describe("resolveConfigHome", () => {
  test("uses XDG_CONFIG_HOME when set to a non-empty value", () => {
    expect(
      resolveConfigHome({ XDG_CONFIG_HOME: "/xdg" }, { platform: "linux" }),
    ).toBe("/xdg");
  });

  test("ignores whitespace-only XDG_CONFIG_HOME", () => {
    expect(
      resolveConfigHome(
        { XDG_CONFIG_HOME: "   " },
        { platform: "linux", homeDir: "/home/u" },
      ),
    ).toBe("/home/u/.config");
  });

  test("falls back to ~/.config on posix", () => {
    expect(
      resolveConfigHome({}, { platform: "linux", homeDir: "/home/u" }),
    ).toBe("/home/u/.config");
  });

  test("uses APPDATA on windows before its fallback", () => {
    expect(
      resolveConfigHome({ APPDATA: "C:\\cfg" }, { platform: "win32" }),
    ).toBe("C:\\cfg");
  });

  test("falls back to %APPDATA%\\Roaming under the profile on windows", () => {
    expect(
      resolveConfigHome({}, { platform: "win32", homeDir: "C:\\Users\\u" }),
    ).toBe("C:\\Users\\u\\AppData\\Roaming");
  });
});

describe("resolveConfigHomes", () => {
  test("posix always has exactly the one canonical home", () => {
    expect(
      resolveConfigHomes(
        { XDG_CONFIG_HOME: "/xdg" },
        { platform: "linux", homeDir: "/home/u" },
      ),
    ).toEqual(["/xdg"]);
  });

  test("windows lists the APPDATA home first, then the legacy XDG home", () => {
    expect(
      resolveConfigHomes(
        { APPDATA: "C:\\cfg" },
        { platform: "win32", homeDir: "C:\\Users\\u" },
      ),
    ).toEqual(["C:\\cfg", "C:\\Users\\u\\.config"]);
  });

  test("windows collapses to a single home when APPDATA matches the legacy one", () => {
    expect(
      resolveConfigHomes(
        { APPDATA: "C:\\Users\\u\\.config" },
        { platform: "win32", homeDir: "C:\\Users\\u" },
      ),
    ).toEqual(["C:\\Users\\u\\.config"]);
  });
});

describe("resolveDataHome", () => {
  test("uses XDG_DATA_HOME when set", () => {
    expect(
      resolveDataHome({ XDG_DATA_HOME: "/data" }, { platform: "linux" }),
    ).toBe("/data");
  });

  test("falls back to ~/.local/share on posix", () => {
    expect(
      resolveDataHome({}, { platform: "linux", homeDir: "/home/u" }),
    ).toBe("/home/u/.local/share");
  });

  test("uses LOCALAPPDATA on windows before its fallback", () => {
    expect(
      resolveDataHome({ LOCALAPPDATA: "C:\\data" }, { platform: "win32" }),
    ).toBe("C:\\data");
  });

  test("falls back to %LOCALAPPDATA%\\Local under the profile on windows", () => {
    expect(
      resolveDataHome({}, { platform: "win32", homeDir: "C:\\Users\\u" }),
    ).toBe("C:\\Users\\u\\AppData\\Local");
  });
});

describe("joinLocalPath", () => {
  test("joins with posix separators on posix platforms", () => {
    expect(
      joinLocalPath({ platform: "linux" }, "/home/u", "cadet-dev", "logs"),
    ).toBe("/home/u/cadet-dev/logs");
  });

  test("joins with windows separators on windows platforms", () => {
    expect(
      joinLocalPath({ platform: "win32" }, "C:\\Users\\u", "cadet", "logs"),
    ).toBe("C:\\Users\\u\\cadet\\logs");
  });
});

describe("assertSafePathSegment", () => {
  test("accepts ordinary assistant ids", () => {
    expect(() => assertSafePathSegment("asst-42", "assistant ID")).not.toThrow();
  });

  test.each([
    [""],
    ["a/b"],
    ["a\\b"],
    ["a\0b"],
    ["."],
    [".."],
  ])("rejects %p on posix", (value) => {
    expect(() =>
      assertSafePathSegment(value, "assistant ID", { platform: "linux" }),
    ).toThrow("Invalid assistant ID");
  });

  test.each([
    ["a<b"],
    ["a>b"],
    ['a"b'],
    ["a:b"],
    ["a|b"],
    ["a?b"],
    ["a*b"],
    ["a."],
    ["a "],
    ["CON"],
    ["con"],
    ["Com1"],
    ["LPT4"],
    ["NUL.exe"],
  ])("rejects %p on windows only", (value) => {
    expect(() =>
      assertSafePathSegment(value, "assistant ID", { platform: "win32" }),
    ).toThrow("Invalid assistant ID");
    // The same value is fine where windows filename rules don't apply.
    expect(() =>
      assertSafePathSegment(value, "assistant ID", { platform: "linux" }),
    ).not.toThrow();
  });
});
