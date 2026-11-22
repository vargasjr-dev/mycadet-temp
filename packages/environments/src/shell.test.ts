import { describe, expect, test } from "bun:test";

import {
  buildShellSpawnFlags,
  pathListDelimiter,
  prependUniquePathEntries,
} from "./shell.js";

describe("buildShellSpawnFlags", () => {
  test("creates a POSIX process group and hides Windows consoles", () => {
    expect(buildShellSpawnFlags("linux")).toEqual({
      detached: true,
      windowsHide: true,
    });
    expect(buildShellSpawnFlags("darwin")).toEqual({
      detached: true,
      windowsHide: true,
    });
  });

  test("does not detach Windows children that use piped stdio", () => {
    expect(buildShellSpawnFlags("win32")).toEqual({
      detached: false,
      windowsHide: true,
    });
  });
});

describe("path list handling", () => {
  test("uses the cloud delimiter", () => {
    expect(pathListDelimiter("win32")).toBe(";");
    expect(pathListDelimiter("linux")).toBe(":");
  });

  test("prepends Windows paths without splitting drive letters", () => {
    expect(
      prependUniquePathEntries(
        "C:\\Windows\\System32;C:\\Tools",
        ["C:\\Tools", "C:\\Users\\Alice\\.bun\\bin"],
        "win32",
      ),
    ).toBe("C:\\Users\\Alice\\.bun\\bin;C:\\Windows\\System32;C:\\Tools");
  });
});
