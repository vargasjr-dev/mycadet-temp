import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readRootProcesses,
  stampRootProcess,
} from "../lib/assistant-config.js";
import {
  DEFAULT_SHELL_MODE,
  readShellMode,
  saveShellMode,
} from "../lib/ingress-config.js";

// Create a temp directory and set CADET_LOCKFILE_DIR so the real lockfile
// helpers resolve inside it (the root-process-lockfile.test.ts pattern).
let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cadet-shell-mode-test-"));
  mkdirSync(join(testDir, "config"), { recursive: true });
  process.env.CADET_LOCKFILE_DIR = join(testDir, "config");
});

afterEach(() => {
  delete process.env.CADET_LOCKFILE_DIR;
  rmSync(testDir, { recursive: true, force: true });
});

function lockfile(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(testDir, "config", "lockfile.json"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("ingress shell mode setting", () => {
  test("an absent lockfile reads as the web default", () => {
    expect(readShellMode()).toBe("web");
  });

  test("a lockfile without the key reads as the web default", () => {
    stampRootProcess("app", {
      pid: 7840,
      startedAt: "2026-10-16T00:00:00.000Z",
    });
    expect(readShellMode()).toBe(DEFAULT_SHELL_MODE);
    expect(readShellMode()).toBe("web");
  });

  test("saves and reads back the app mode", () => {
    saveShellMode("app");
    expect(readShellMode()).toBe("app");
    saveShellMode("web");
    expect(readShellMode()).toBe("web");
  });

  test("saving lands at the lockfile root beside the app record", () => {
    stampRootProcess("app", {
      pid: 7840,
      startedAt: "2026-10-16T00:00:00.000Z",
    });
    saveShellMode("app");
    const saved = lockfile();
    expect(saved.edgeShell).toBe("app");
    // The lifecycle-scoped nginx record the setting configures survives.
    expect(readRootProcesses().app?.pid).toBe(7840);
  });

  test("an unrecognized value fails loudly instead of defaulting", () => {
    writeFileSync(
      join(testDir, "config", "lockfile.json"),
      JSON.stringify({ edgeShell: "aps" }) + "\n",
    );
    expect(() => readShellMode()).toThrow('must be "web" or "app"');
  });
});
