import { describe, expect, test } from "bun:test";
import path from "node:path";

describe("prepare-electron-dev-app", () => {
  // Runs the script as its own process (it mutates the Electron bundle's
  // plist, so it must never run in-suite). The failure class this guards is
  // the import chain: the script's getAppName import has to resolve without
  // touching the electron module, or the script dies off-Electron. Skipped
  // on macOS — there the script stamps the developer's real Electron.app,
  // which `bun scripts/prepare-electron-dev-app.ts` (the dev flow) already
  // owns.
  test.skipIf(process.platform === "darwin")("runs clean off-Electron", () => {
    const proc = Bun.spawnSync(["bun", "scripts/prepare-electron-dev-app.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr.toString()).not.toMatch(/error|Cannot find/i);
    expect(proc.exitCode).toBe(0);
  });
});
