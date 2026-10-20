import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const TEST_DIR = process.env.CADET_WORKSPACE_DIR!;

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

const { buildSystemPrompt } = await import("../prompts/system-prompt.js");

describe("Dynamic Skill Authoring Workflow moved to tool descriptions", () => {
  test("system prompt no longer contains Dynamic Skill Authoring section", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Cadet.");
    const result = buildSystemPrompt();
    expect(result).not.toContain("## Dynamic Skill Authoring Workflow");
    expect(result).not.toContain("### Community Skills Discovery");
  });

  test("prompt no longer includes available skills catalog", () => {
    const skillsDir = join(TEST_DIR, "skills");
    mkdirSync(join(skillsDir, "test-skill"), { recursive: true });
    writeFileSync(
      join(skillsDir, "test-skill", "SKILL.md"),
      '---\nname: "Test Skill"\ndescription: "For testing."\n---\n\nDo testing.\n',
    );
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Cadet.");

    const result = buildSystemPrompt();
    expect(result).not.toContain("## Available Skills");
    expect(result).not.toContain("**test-skill**");
  });

  test("prompt is additive with IDENTITY/SOUL files", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity here");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "Soul here");

    const result = buildSystemPrompt();
    expect(result).toContain("Identity here");
    expect(result).toContain("Soul here");
  });

  test("browser skill activation hints no longer appear in system prompt", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Cadet.");
    const result = buildSystemPrompt();
    expect(result).not.toContain("Browser Skill Prerequisite");
    // Skills catalog removed from system prompt — activation hints live in capability memories
    expect(result).not.toContain("## Available Skills");
  });
});
