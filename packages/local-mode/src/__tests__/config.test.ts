import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { instanceStateDir } from "../config";

describe("instanceStateDir", () => {
  test("modern instances flatten state into the instance dir", () => {
    const instanceDir = path.join(os.tmpdir(), "assistants", "asst-1");
    expect(instanceStateDir(instanceDir)).toBe(instanceDir);
  });

  test("legacy first-local instances (instanceDir === home) keep ~/.cadet", () => {
    const home = os.homedir();
    expect(instanceStateDir(home)).toBe(path.join(home, ".cadet"));
  });

  test("home comparison can be injected for hermetic tests", () => {
    const fakeHome = "/home/assistant";
    expect(instanceStateDir(fakeHome, fakeHome)).toBe(
      path.join(fakeHome, ".cadet"),
    );
    expect(instanceStateDir("/elsewhere/asst-1", fakeHome)).toBe(
      "/elsewhere/asst-1",
    );
  });
});
