import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const TEST_DIR = process.env.CADET_WORKSPACE_DIR!;

const { ensureWorkspaceSeedSkills } =
  await import("../skills/workspace-seed.js");

const SEED_DEST = join(TEST_DIR, "skills", "visualize", "SKILL.md");

describe("workspace seed skills", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir)) {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  test("seeds visualize into the workspace skills dir", () => {
    ensureWorkspaceSeedSkills();
    expect(existsSync(SEED_DEST)).toBe(true);
    // The seed carries the frontmatter the runtime routes on.
    expect(readFileSync(SEED_DEST, "utf8")).toContain("always-candidate: true");
  });

  test("never overwrites a user-edited seed", () => {
    mkdirSync(join(TEST_DIR, "skills", "visualize"), { recursive: true });
    writeFileSync(SEED_DEST, "---\nname: visualize\ndescription: mine\n---\n");
    ensureWorkspaceSeedSkills();
    expect(readFileSync(SEED_DEST, "utf8")).toContain("description: mine");
  });
});
