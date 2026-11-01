import { resolveLockfilePath } from "@mycadet/local-mode";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
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
import { basename, join } from "node:path";

import { type LockfileAssistant } from "@mycadet/local-mode/contract";
import * as stepRunnerModule from "../lib/step-runner.js";
import * as wakeModule from "../commands/wake.js";
import { makeEntry, readLocalEntry } from "./helpers/lockfile-entry.js";

// Captured real exports — afterAll restores these so module mocks don't
// leak into other test files in the same `bun test` run.
const realExec = stepRunnerModule.exec;

// Prevent a real wake (daemon / gateway / CES spawn) during recovery
const wakeAssistantMock = mock(async (_entry: LockfileAssistant) => ({
  ok: true as const,
}));

// Capture exec calls without running real tar
const execMock = mock(async (_cmd: string, _args: string[]) => {});

beforeAll(() => {
  mock.module("../commands/wake.js", () => ({
    ...wakeModule,
    wakeAssistant: wakeAssistantMock,
  }));
  mock.module("../lib/step-runner.js", () => ({ exec: execMock }));
});

afterAll(() => {
  mock.module("../commands/wake.js", () => wakeModule);
  mock.module("../lib/step-runner.js", () => ({ exec: realExec }));
});

import { restore } from "../commands/restore.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const testDir = mkdtempSync(join(tmpdir(), "cli-recover-test-"));
const originalArgv = [...process.argv];
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgData = process.env.XDG_DATA_HOME;

// Directories that getRetiredDir() will use when XDG_DATA_HOME is overridden
const retiredDir = join(testDir, "cadet", "retired");

function writeArchiveFixtures(
  name: string,
  entry: LockfileAssistant,
  key: string | null = "07".repeat(32),
): {
  archivePath: string;
  metadataPath: string;
  extractedPath: string;
} {
  mkdirSync(retiredDir, { recursive: true });
  const archivePath = join(retiredDir, `${name}.tar.gz`);
  const metadataPath = join(retiredDir, `${name}.json`);
  // The staging dir is what tar extracts — <archive>.staging relative to retiredDir
  const extractedPath = join(retiredDir, basename(archivePath) + ".staging");

  // Write a placeholder archive file (exec is mocked; content doesn't matter)
  writeFileSync(archivePath, "");
  writeFileSync(metadataPath, JSON.stringify(entry, null, 2) + "\n");
  // Create the staging dir that tar would have created
  mkdirSync(extractedPath, { recursive: true });
  // The identity rides the archive's key file; null stages an archive
  // without one.
  if (key) {
    mkdirSync(join(extractedPath, "gateway-security"), { recursive: true });
    writeFileSync(
      join(extractedPath, "gateway-security", "actor-token-signing-key"),
      Buffer.from(key, "hex"),
    );
  }

  return { archivePath, metadataPath, extractedPath };
}

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
  // Write an empty lockfile so saveLockfileAssistant has a dir to write to
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

  execMock.mockClear();
  wakeAssistantMock.mockClear();
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

// Runs after all tests finish
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

// ── Tests ─────────────────────────────────────────────────────────────────────

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

  test("exits 1 when target .cadet/ already exists", async () => {
    const name = "already-exists";
    const instanceDir = join(testDir, name);
    makeEntry({ assistantId: name, instanceDir });
    const entry = readLocalEntry(name);
    writeArchiveFixtures(name, entry);
    // Pre-create the collision path that recover checks
    mkdirSync(join(instanceDir, ".cadet"), { recursive: true });
    process.argv = ["bun", "cadet", "restore", name];
    await expect(restore()).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("already exists");
  });
});

describe("archive-recovery extraction path — named instance (instanceDir !== homedir())", () => {
  test("extracts to retiredDir and renames staging dir to instanceDir directly", async () => {
    const name = "named-instance";
    const instanceDir = join(testDir, "custom-location", name);
    makeEntry({
      assistantId: name,
      instanceDir,
    });
    const entry = readLocalEntry(name);
    const { archivePath, extractedPath } = writeArchiveFixtures(name, entry);

    // Named instance: targetDir is instanceDir itself (not instanceDir/.cadet)
    const expectedTargetDir = instanceDir;
    // Parent dir must exist for renameSync
    mkdirSync(join(testDir, "custom-location"), { recursive: true });

    process.argv = ["bun", "cadet", "restore", name];
    await restore();

    // exec must have been called with -C retiredDir
    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("tar");
    const cIndex = args.indexOf("-C");
    expect(args[cIndex + 1]).toBe(retiredDir);

    // Staging dir was renamed to instanceDir (not instanceDir/.cadet)
    expect(existsSync(extractedPath)).toBe(false);
    expect(existsSync(expectedTargetDir)).toBe(true);

    // Archive cleaned up
    expect(existsSync(archivePath)).toBe(false);

    // The recovered assistant was woken once
    expect(wakeAssistantMock).toHaveBeenCalledTimes(1);
    expect(wakeAssistantMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ instanceDir: expect.any(String) }),
    );
  });

  test("creates parent directories of instanceDir when they do not exist", async () => {
    const name = "deep-nested-instance";
    // Use a path whose parent directory does not yet exist
    const instanceDir = join(testDir, "new-parent", "deeper", name);
    makeEntry({ assistantId: name, instanceDir });
    const entry = readLocalEntry(name);
    const { archivePath, extractedPath } = writeArchiveFixtures(name, entry);

    process.argv = ["bun", "cadet", "restore", name];
    await restore();

    expect(existsSync(extractedPath)).toBe(false);
    expect(existsSync(instanceDir)).toBe(true);
    expect(existsSync(archivePath)).toBe(false);

    rmSync(instanceDir, { recursive: true, force: true });
  });
});
