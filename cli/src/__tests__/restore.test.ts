import { resolveLockfilePath } from "@mycadet/local-mode";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as osModule from "node:os";
import { join } from "node:path";

import { makeEntry, readLocalEntry } from "./helpers/lockfile-entry.js";

// The recovery/extraction mechanics live in the package now
// (packages/local-mode operations/restore + remotes/local/restore) and are
// covered there. This file keeps the command's UX contract: usage text and
// the error taxonomy.

import { restore } from "../commands/restore.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-recover-test-"));
const originalArgv = [...process.argv];
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgData = process.env.XDG_DATA_HOME;

// Directories getRetiredDir() uses when XDG_DATA_HOME is overridden
const retiredDir = join(testDir, "cadet", "retired");

let homeSpy: ReturnType<typeof spyOn>;
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  homeSpy = spyOn(osModule, "homedir").mockReturnValue(join(testDir, "home"));
  mkdirSync(homedir(), { recursive: true });
  // Route lockfile and retired archives to the temp directory
  process.env.XDG_CONFIG_HOME = testDir;
  process.env.XDG_DATA_HOME = testDir;
  // Write an empty lockfile so the lockfile helpers have a dir to read
  mkdirSync(join(testDir, "cadet"), { recursive: true });
  writeFileSync(
    resolveLockfilePath(),
    JSON.stringify({ assistants: [] }) + "\n",
  );

  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
    throw new Error(`process.exit(${_code})`);
  });
});

afterEach(() => {
  homeSpy.mockRestore();
  process.argv = [...originalArgv];
  process.env.XDG_CONFIG_HOME = originalConfigHome;
  process.env.XDG_DATA_HOME = originalXdgData;
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
  // Clean up per-test artifacts inside testDir/cadet/
  if (existsSync(join(testDir, "cadet"))) {
    rmSync(join(testDir, "cadet"), { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  process.argv = [...originalArgv];
  if (originalConfigHome !== undefined) {
    process.env.XDG_CONFIG_HOME = originalConfigHome;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  if (originalXdgData !== undefined) {
    process.env.XDG_DATA_HOME = originalXdgData;
  } else {
    delete process.env.XDG_DATA_HOME;
  }
});

describe("restore --help", () => {
  test("prints usage, description, and examples then exits 0", async () => {
    process.argv = ["bun", "cadet", "restore", "--help"];
    await expect(restore()).rejects.toThrow("process.exit(0)");
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Usage: cadet restore <name>");
    expect(output).toContain("recovers a retired assistant");
    expect(output).toContain("Examples:");
    expect(output).toContain("cadet restore");
  });
});

describe("restore error cases", () => {
  test("exits 1 when no name is given", async () => {
    process.argv = ["bun", "cadet", "restore"];
    await expect(restore()).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("<name> is required");
  });

  test("exits 1 when archive is missing", async () => {
    process.argv = ["bun", "cadet", "restore", "ghost-assistant"];
    await expect(restore()).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain(
      "No retired archive found for 'ghost-assistant'",
    );
  });

  test("exits 1 when the recovering target already exists", async () => {
    const name = "already-exists";
    const instanceDir = join(testDir, name);
    makeEntry({ assistantId: name, instanceDir });
    const entry = readLocalEntry(name);
    mkdirSync(retiredDir, { recursive: true });
    writeFileSync(join(retiredDir, `${name}.tar.gz`), "");
    writeFileSync(
      join(retiredDir, `${name}.json`),
      JSON.stringify(entry, null, 2) + "\n",
    );
    // Pre-create the collision path the recovery checks
    mkdirSync(join(instanceDir, ".cadet"), { recursive: true });
    process.argv = ["bun", "cadet", "restore", name];
    await expect(restore()).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("already exists");
  });
});
