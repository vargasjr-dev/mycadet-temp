/**
 * Unit tests for workspace-authored greeting parsing.
 */

import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";

import {
  parseGreetingsSection,
  readWorkspaceGreetings,
} from "../runtime/routes/workspace-greetings.js";
import { getWorkspacePromptPath } from "../util/platform.js";

// Real SOUL.md in the preload's per-process workspace; dropped after each
// test so absence assertions are honest.
const SOUL_PATH = getWorkspacePromptPath("SOUL.md");

function setWorkspaceFiles(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(getWorkspacePromptPath(name), content);
  }
}

afterEach(() => {
  rmSync(SOUL_PATH, { force: true });
});

describe("parseGreetingsSection", () => {
  test("parses bullet list from ## Greetings section", () => {
    const content = [
      "# Soul",
      "",
      "## Greetings",
      "- Hey there, friend!",
      "- What's on your mind?",
      "- Ready to roll!",
      "",
      "## Other Section",
      "Some other content.",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual([
      "Hey there, friend!",
      "What's on your mind?",
      "Ready to roll!",
    ]);
  });

  test("handles asterisk bullets", () => {
    const content = ["## Greetings", "* Hello!", "* Hi there."].join("\n");

    expect(parseGreetingsSection(content)).toEqual(["Hello!", "Hi there."]);
  });

  test("handles plus and numbered bullets", () => {
    const content = [
      "## Greetings",
      "+ Welcome back.",
      "1. Ready when you are.",
      "2) What are we building today?",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual([
      "Welcome back.",
      "Ready when you are.",
      "What are we building today?",
    ]);
  });

  test("only starts at a level-two Greetings heading", () => {
    const content = [
      "# Greetings",
      "- Not the section contract.",
      "",
      "## Greetings",
      "- The real greeting.",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual(["The real greeting."]);
  });

  test("returns null when section is missing", () => {
    const content = ["# Soul", "## Personality", "Be friendly."].join("\n");

    expect(parseGreetingsSection(content)).toBeNull();
  });

  test("returns null when section is empty", () => {
    const content = ["## Greetings", "", "## Next Section"].join("\n");

    expect(parseGreetingsSection(content)).toBeNull();
  });

  test("ignores non-bullet lines in section", () => {
    const content = [
      "## Greetings",
      "Some intro text that's not a bullet",
      "- Actual greeting",
      "Another non-bullet line",
      "- Second greeting",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual([
      "Actual greeting",
      "Second greeting",
    ]);
  });

  test("allows nested headings and stops at the next same-or-higher heading", () => {
    const content = [
      "## Greetings",
      "- First",
      "- Second",
      "### Sub-heading",
      "- Third",
      "## Other Section",
      "- Should not appear",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });
});

describe("readWorkspaceGreetings", () => {
  test("reads greetings from SOUL.md", () => {
    setWorkspaceFiles({
      "SOUL.md": ["# Soul", "## Greetings", "- Hey!", "- What's up?"].join(
        "\n",
      ),
    });

    expect(readWorkspaceGreetings()).toEqual(["Hey!", "What's up?"]);
  });

  test("returns null when SOUL.md has no greetings section", () => {
    setWorkspaceFiles({ "SOUL.md": "# Soul\nBe friendly." });
    expect(readWorkspaceGreetings()).toBeNull();
  });

  test("returns null when SOUL.md does not exist", () => {
    expect(readWorkspaceGreetings()).toBeNull();
  });
});
