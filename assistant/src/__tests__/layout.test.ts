import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import {
  ensureDataDir,
  formatHomeRelativePath,
  getDataDir,
  getDbPath,
  getHistoryPath,
  getLogsDir,
  getPidPath,
  getSandboxRootDir,
  getSandboxWorkingDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
  getWorkspacePromptPath,
  getWorkspaceSkillsDir,
} from "../util/layout.js";

const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;

// This file characterizes path resolution itself (including the cwd
// fallback and literal override paths) without reading or writing those
// locations, so the live-workspace guard is deliberately bypassed.
const originalAllowRealWorkspace =
  process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;
process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS = "1";
afterAll(() => {
  if (originalAllowRealWorkspace === undefined) {
    delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;
  } else {
    process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS =
      originalAllowRealWorkspace;
  }
});
const originalCadetEnvironment = process.env.CADET_ENVIRONMENT;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalWorkspaceDir == null) {
    delete process.env.CADET_WORKSPACE_DIR;
  } else {
    process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalCadetEnvironment == null) {
    delete process.env.CADET_ENVIRONMENT;
  } else {
    process.env.CADET_ENVIRONMENT = originalCadetEnvironment;
  }
  if (originalXdgConfigHome == null) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

// Path characterization: documents the current path layout.
// Workspace helpers resolve under CADET_WORKSPACE_DIR when set,
// otherwise under <cwd>/workspace.
describe("path characterization", () => {
  test("formats Windows workspace paths relative to the home directory", () => {
    expect(
      formatHomeRelativePath(
        "C:\\Users\\Alice\\.cadet\\workspace",
        "C:\\Users\\Alice",
        win32,
      ),
    ).toBe("~\\.cadet\\workspace");
    expect(
      formatHomeRelativePath("D:\\Cadet\\workspace", "C:\\Users\\Alice", win32),
    ).toBe("D:\\Cadet\\workspace");
  });

  test("all path helpers resolve to expected locations", () => {
    // Without CADET_WORKSPACE_DIR override, workspace is <cwd>/workspace
    delete process.env.CADET_WORKSPACE_DIR;
    const root = process.cwd();
    const ws = getWorkspaceDir();
    const data = getDataDir();

    // Workspace is under root
    expect(ws).toBe(join(root, "workspace"));

    // Data dir is under workspace
    expect(data).toBe(join(ws, "data"));

    // Sub-paths under workspace/data
    expect(getDbPath()).toBe(join(data, "db", "assistant.db"));
    expect(getLogsDir()).toBe(join(data, "logs"));
    expect(getHistoryPath()).toBe(join(data, "history"));
    expect(getSandboxRootDir()).toBe(join(data, "sandbox"));
    expect(getSandboxWorkingDir()).toBe(ws);

    // Hooks live under workspace
    expect(getWorkspaceHooksDir()).toBe(join(ws, "hooks"));

    // PID file lives in the workspace directory
    expect(getPidPath()).toBe(join(ws, "cadet.pid"));
  });

  test("CADET_WORKSPACE_DIR overrides workspace location", () => {
    process.env.CADET_WORKSPACE_DIR = "/tmp/custom-workspace";
    expect(getWorkspaceDir()).toBe("/tmp/custom-workspace");
    expect(getDataDir()).toBe("/tmp/custom-workspace/data");
    // PID path follows workspace override
    expect(getPidPath()).toBe("/tmp/custom-workspace/cadet.pid");
  });

  test("hooks directory is inside the workspace boundary", () => {
    delete process.env.CADET_WORKSPACE_DIR;
    expect(getWorkspaceHooksDir().startsWith(getWorkspaceDir())).toBe(true);
  });

  test("ensureDataDir creates all expected directories", () => {
    // Use a temp CADET_WORKSPACE_DIR so ensureDataDir writes to a temp dir
    // rather than the real cwd. Root-level dirs resolve from the workspace
    // parent; we only verify workspace dirs here to avoid side effects.
    const wsDir = join(tmpdir(), `platform-test-ws-${Date.now()}`);
    process.env.CADET_WORKSPACE_DIR = wsDir;

    ensureDataDir();

    // Root-level dirs (ensureDataDir always creates these)
    const root = dirname(wsDir);
    expect(existsSync(root)).toBe(true);

    // Workspace dirs (in our temp location)
    expect(existsSync(wsDir)).toBe(true);
    expect(existsSync(join(wsDir, "skills"))).toBe(true);

    // Data sub-dirs under workspace
    const data = join(wsDir, "data");
    expect(existsSync(data)).toBe(true);
    expect(existsSync(join(data, "db"))).toBe(true);
    expect(existsSync(join(data, "qdrant"))).toBe(true);
    expect(existsSync(join(data, "logs"))).toBe(true);
    expect(existsSync(join(data, "memory"))).toBe(true);
    expect(existsSync(join(data, "memory", "knowledge"))).toBe(true);
    expect(existsSync(join(data, "apps"))).toBe(true);

    rmSync(wsDir, { recursive: true, force: true });
  });
});

describe("workspace path primitives", () => {
  test("workspace helpers resolve under workspace dir", () => {
    delete process.env.CADET_WORKSPACE_DIR;
    const ws = getWorkspaceDir();

    expect(getWorkspaceConfigPath()).toBe(join(ws, "config.json"));
    expect(getWorkspaceSkillsDir()).toBe(join(ws, "skills"));
    expect(getWorkspaceHooksDir()).toBe(join(ws, "hooks"));
    expect(getWorkspacePluginsDir()).toBe(join(ws, "plugins"));
    expect(getWorkspacePromptPath("IDENTITY.md")).toBe(join(ws, "IDENTITY.md"));
    expect(getWorkspacePromptPath("SOUL.md")).toBe(join(ws, "SOUL.md"));
  });
});
