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

import { LLMSchema } from "../config/schemas/llm.js";
import { seedDefaultInferenceProfiles052 } from "../workspace/migrations/052-seed-default-inference-profiles.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `cadet-migration-052-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("052-seed-default-inference-profiles migration", () => {
  test("has correct migration id", () => {
    expect(seedDefaultInferenceProfiles052.id).toBe(
      "052-seed-default-inference-profiles",
    );
  });

  // The migration is retired: default profile content is code-owned
  // (config/default-profile-catalog.ts) and resolves through the effective
  // profile view whether or not `llm.profiles` carries an entry. Fresh
  // hatches must leave `llm.profiles` empty so a hatch that selects, say,
  // fireworks dispatches the code-defined defaults for that provider instead
  // of seeded Anthropic bodies.

  test("leaves a workspace without llm config untouched", () => {
    writeConfig({ settings: { theme: "dark" } });

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as { llm?: unknown };
    expect(config.llm).toBeUndefined();
  });

  test("leaves existing profiles untouched", () => {
    const before = {
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          balanced: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
        activeProfile: "balanced",
      },
    };
    writeConfig(before);

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as typeof before;
    expect(config.llm.profiles).toEqual(before.llm.profiles);
    expect(config.llm.activeProfile).toBe("balanced");
  });

  test("empty llm.profiles passes the typed LLM schema", () => {
    // The state a fresh hatch lands in: default provider set (the hatch's
    // provider choice), no seeded profile entries.
    const parsed = LLMSchema.parse({
      default: { provider: "fireworks" },
      activeProfile: "balanced",
    });
    expect(parsed.activeProfile).toBe("balanced");
    expect(Object.keys(parsed.profiles ?? {})).toEqual([]);
  });
});
