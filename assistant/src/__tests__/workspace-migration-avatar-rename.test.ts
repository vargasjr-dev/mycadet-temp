import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { avatarRenameMigration } from "../workspace/migrations/001-avatar-rename.js";

// Real fs: each test runs the migration against a fresh temp workspace with
// real avatar files on disk.
let WORKSPACE_DIR: string;
const OLD_IMAGE = () => join(WORKSPACE_DIR, "data/avatar/custom-avatar.png");
const NEW_IMAGE = () => join(WORKSPACE_DIR, "data/avatar/avatar-image.png");
const OLD_TRAITS = () =>
  join(WORKSPACE_DIR, "data/avatar/avatar-components.json");
const NEW_TRAITS = () =>
  join(WORKSPACE_DIR, "data/avatar/character-traits.json");

function seedFile(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
}

describe("001-avatar-rename migration", () => {
  beforeEach(() => {
    WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "mig-001-"));
  });

  afterEach(() => {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("renames both files when old names exist", () => {
    seedFile(OLD_IMAGE());
    seedFile(OLD_TRAITS());

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(existsSync(NEW_IMAGE())).toBe(true);
    expect(existsSync(NEW_TRAITS())).toBe(true);
    expect(existsSync(OLD_IMAGE())).toBe(false);
    expect(existsSync(OLD_TRAITS())).toBe(false);
  });

  test("no-op when new files already exist", () => {
    seedFile(OLD_IMAGE());
    seedFile(NEW_IMAGE());
    seedFile(OLD_TRAITS());
    seedFile(NEW_TRAITS());

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(existsSync(NEW_IMAGE())).toBe(true);
    expect(existsSync(NEW_TRAITS())).toBe(true);
  });

  test("no-op when no old files exist", () => {
    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(existsSync(NEW_IMAGE())).toBe(false);
    expect(existsSync(NEW_TRAITS())).toBe(false);
  });

  test("partial rename — only image exists", () => {
    seedFile(OLD_IMAGE());

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(existsSync(NEW_IMAGE())).toBe(true);
    expect(existsSync(NEW_TRAITS())).toBe(false);
  });

  test("partial rename — only traits exist", () => {
    seedFile(OLD_TRAITS());

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(existsSync(NEW_TRAITS())).toBe(true);
    expect(existsSync(NEW_IMAGE())).toBe(false);
  });
});
