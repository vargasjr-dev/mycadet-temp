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

import { repairAdaptiveThinkingOnCloudProfiles } from "../workspace/adaptive-thinking-repair.js";

const ADAPTIVE = { enabled: true, streamThinking: true };

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `cadet-adaptive-thinking-repair-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function profile(name: string): Record<string, unknown> {
  const config = readConfig();
  const llm = config.llm as Record<string, unknown>;
  const profiles = llm.profiles as Record<string, unknown>;
  return profiles[name] as Record<string, unknown>;
}

describe("repairAdaptiveThinkingOnCloudProfiles", () => {
  test("patches managed Anthropic profiles missing thinking", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-sonnet-4-6" },
        profiles: {
          balanced: { provider: "anthropic" },
          "quality-optimized": {
            provider: "anthropic",
            thinking: { enabled: false },
          },
        },
      },
    });

    repairAdaptiveThinkingOnCloudProfiles(workspaceDir);

    expect(profile("balanced").thinking).toEqual(ADAPTIVE);
    expect(profile("quality-optimized").thinking).toEqual(ADAPTIVE);
  });

  test("skips empty shells when llm.default.provider is non-Anthropic", () => {
    // Migration 052 seeds empty {} shells (no provider) on legacy
    // non-Anthropic workspaces. They inherit the non-Anthropic provider from
    // llm.default and must stay off the Anthropic-specific repair.
    writeConfig({
      llm: {
        default: { provider: "gemini", model: "gemini-2.5-pro" },
        profiles: {
          balanced: {},
          "quality-optimized": {},
        },
      },
    });

    repairAdaptiveThinkingOnCloudProfiles(workspaceDir);

    expect(profile("balanced")).toEqual({});
    expect(profile("quality-optimized")).toEqual({});
  });

  test("treats absent llm.default.provider as Anthropic", () => {
    writeConfig({
      llm: {
        default: { model: "claude-sonnet-4-6" },
        profiles: {
          balanced: {},
        },
      },
    });

    repairAdaptiveThinkingOnCloudProfiles(workspaceDir);

    expect(profile("balanced").thinking).toEqual(ADAPTIVE);
  });

  test("explicit Anthropic provider on the profile wins over a non-Anthropic default", () => {
    writeConfig({
      llm: {
        default: { provider: "gemini" },
        profiles: {
          balanced: { provider: "anthropic" },
        },
      },
    });

    repairAdaptiveThinkingOnCloudProfiles(workspaceDir);

    expect(profile("balanced").thinking).toEqual(ADAPTIVE);
  });

  test("patches profiles pinning a known Claude model under a non-Anthropic default", () => {
    // A profile that omits `provider` but pins a known Claude model is
    // Anthropic via the resolver's model-implied provider, even when
    // llm.default.provider is non-Anthropic. It must still get adaptive
    // thinking rather than being skipped.
    writeConfig({
      llm: {
        default: { provider: "gemini", model: "gemini-2.5-pro" },
        profiles: {
          balanced: { model: "claude-sonnet-4-6" },
          "quality-optimized": { model: "claude-opus-4-8" },
        },
      },
    });

    repairAdaptiveThinkingOnCloudProfiles(workspaceDir);

    expect(profile("balanced").thinking).toEqual(ADAPTIVE);
    expect(profile("quality-optimized").thinking).toEqual(ADAPTIVE);
  });

  test("skips profiles with an explicit non-Anthropic provider", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          balanced: { provider: "gemini" },
        },
      },
    });

    repairAdaptiveThinkingOnCloudProfiles(workspaceDir);

    expect(profile("balanced").thinking).toBeUndefined();
  });

  test("is idempotent when thinking is already enabled", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          balanced: {
            thinking: { enabled: true, streamThinking: false },
          },
        },
      },
    });

    repairAdaptiveThinkingOnCloudProfiles(workspaceDir);

    expect(profile("balanced").thinking).toEqual({
      enabled: true,
      streamThinking: false,
    });
  });
});
