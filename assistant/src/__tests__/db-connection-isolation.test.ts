import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { resetDbForTesting } from "./db-test-helpers.js";

const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
const originalAllowRealWorkspace =
  process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;
const originalTestRealWorkspace = process.env.CADET_TEST_REAL_WORKSPACE_DIR;
const originalHome = process.env.HOME;

afterEach(() => {
  resetDbForTesting();
  if (originalWorkspaceDir === undefined) {
    delete process.env.CADET_WORKSPACE_DIR;
  } else {
    process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
  }

  if (originalAllowRealWorkspace === undefined) {
    delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;
  } else {
    process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS =
      originalAllowRealWorkspace;
  }

  if (originalTestRealWorkspace === undefined) {
    delete process.env.CADET_TEST_REAL_WORKSPACE_DIR;
  } else {
    process.env.CADET_TEST_REAL_WORKSPACE_DIR = originalTestRealWorkspace;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

test("getDb refuses test runs without an isolated workspace", () => {
  resetDbForTesting();
  delete process.env.CADET_WORKSPACE_DIR;
  delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;

  expect(() => getDb()).toThrow(
    "Refusing to open the assistant DB during tests without CADET_WORKSPACE_DIR",
  );
});

test("getDb refuses the real workspace during tests even when explicitly set", () => {
  resetDbForTesting();
  process.env.CADET_TEST_REAL_WORKSPACE_DIR = join(
    homedir(),
    ".local",
    "share",
    "cadet",
    "workspace",
  );
  process.env.CADET_WORKSPACE_DIR = join(
    homedir(),
    ".local",
    "share",
    "cadet",
    "workspace",
  );
  delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;

  expect(() => getDb()).toThrow(
    "Refusing to open the real assistant workspace DB during tests",
  );
});

test("getDb refuses symlink aliases to the real workspace during tests", () => {
  resetDbForTesting();
  const testRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "cadet-db-isolation-")),
  );

  try {
    const fakeHome = join(testRoot, "home");
    const realWorkspace = join(fakeHome, ".cadet", "workspace");
    const aliasParent = join(testRoot, "aliases");
    const workspaceAlias = join(aliasParent, "workspace-link");

    mkdirSync(realWorkspace, { recursive: true });
    mkdirSync(aliasParent, { recursive: true });
    symlinkSync(realWorkspace, workspaceAlias, "dir");

    process.env.HOME = fakeHome;
    process.env.CADET_WORKSPACE_DIR = workspaceAlias;
    process.env.CADET_TEST_REAL_WORKSPACE_DIR = realWorkspace;
    delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;

    expect(() => getDb()).toThrow(
      "Refusing to open the real assistant workspace DB during tests",
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("getDb refuses missing children under symlink aliases to the real workspace", () => {
  resetDbForTesting();
  const testRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "cadet-db-isolation-")),
  );

  try {
    const fakeHome = join(testRoot, "home");
    const realWorkspace = join(fakeHome, ".cadet", "workspace");
    const aliasParent = join(testRoot, "aliases");
    const workspaceLink = join(aliasParent, "workspace-link");
    const missingChild = join(workspaceLink, "new-test-workspace");

    mkdirSync(realWorkspace, { recursive: true });
    mkdirSync(aliasParent, { recursive: true });
    symlinkSync(realWorkspace, workspaceLink, "dir");

    process.env.HOME = fakeHome;
    process.env.CADET_WORKSPACE_DIR = missingChild;
    process.env.CADET_TEST_REAL_WORKSPACE_DIR = realWorkspace;
    delete process.env.CADET_ALLOW_REAL_WORKSPACE_IN_TESTS;

    expect(() => getDb()).toThrow(
      "Refusing to open the real assistant workspace DB during tests",
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
