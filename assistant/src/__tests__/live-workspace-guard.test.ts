/**
 * Tests for the live-workspace guard in util/platform.ts: a test process must
 * never resolve the workspace to a directory outside os.tmpdir().
 */

import { rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { getWorkspaceDir } from "../util/platform.js";

const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
const originalAllowReal = process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;

afterEach(() => {
  process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
  if (originalAllowReal === undefined) {
    delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;
  } else {
    process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS = originalAllowReal;
  }
});

describe("live-workspace guard", () => {
  test("allows the preload's tmpdir workspace", () => {
    expect(getWorkspaceDir()).toBe(process.env.CADET_WORKSPACE_DIR!);
  });

  test("allows a not-yet-created nested path under tmpdir", () => {
    const dir = join(
      tmpdir(),
      "cadet-guard-nonexistent",
      "nested",
      "workspace",
    );
    process.env.CADET_WORKSPACE_DIR = dir;
    expect(getWorkspaceDir()).toBe(dir);
  });

  test("refuses a non-tmpdir workspace in a test process", () => {
    delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;
    process.env.CADET_WORKSPACE_DIR = join(homedir(), "cadet-guard-live");
    expect(() => getWorkspaceDir()).toThrow(/Refusing to use/);
  });

  test("refuses a tmpdir symlink that resolves outside tmpdir", () => {
    delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;
    const link = join(tmpdir(), `cadet-guard-escape-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(homedir(), link);
    try {
      process.env.CADET_WORKSPACE_DIR = link;
      expect(() => getWorkspaceDir()).toThrow(/Refusing to use/);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("CADET_ALLOW_REAL_WORKSPACE_IN_TESTS=1 bypasses the guard", () => {
    const dir = join(homedir(), "cadet-guard-live-optout");
    process.env.CADET_WORKSPACE_DIR = dir;
    process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS = "1";
    expect(getWorkspaceDir()).toBe(dir);
  });

  test("opt-out is per-call, not cached: same dir throws once the var clears", () => {
    const dir = join(homedir(), "cadet-guard-live-optout-cleared");
    process.env.CADET_WORKSPACE_DIR = dir;
    process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS = "1";
    expect(getWorkspaceDir()).toBe(dir);
    delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;
    expect(() => getWorkspaceDir()).toThrow(/Refusing to use/);
  });
});
