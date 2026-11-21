import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { seedConversationStartersCallsiteMigration } from "../workspace/migrations/046-seed-conversation-starters-callsite.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `cadet-migration-046-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("046-seed-conversation-starters-callsite migration", () => {
  test("has correct migration id", () => {
    expect(seedConversationStartersCallsiteMigration.id).toBe(
      "046-seed-conversation-starters-callsite",
    );
  });

  // The conversation-starters feature was removed outright — the call
  // site no longer exists in the schema, so seeding would write an
  // orphan key the config loader rejects. The migration must write
  // nothing, no matter what the workspace config looks like.
  test("is a no-op — writes nothing on any workspace", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    seedConversationStartersCallsiteMigration.run(workspaceDir);

    expect(readConfig()).toEqual({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });
  });

  test("is a no-op on a missing config.json", () => {
    seedConversationStartersCallsiteMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });
});
