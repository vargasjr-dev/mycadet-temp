import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { dropLlmDefaultBlobMigration } from "../162-drop-llm-default-blob.js";

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function setup(): string {
  const workspace = mkdtempSync(join(tmpdir(), "drop-llm-default-migration-"));
  workspaces.push(workspace);
  return workspace;
}

function writeConfig(workspace: string, data: unknown): void {
  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(workspace: string): Record<string, any> {
  return JSON.parse(readFileSync(join(workspace, "config.json"), "utf-8"));
}

describe("dropLlmDefaultBlobMigration", () => {
  test("derives defaultProvider from the blob and deletes the blob", () => {
    const workspace = setup();
    writeConfig(workspace, {
      llm: {
        default: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    });
    dropLlmDefaultBlobMigration.run(workspace);
    const llm = readConfig(workspace).llm;
    expect(llm.default).toBeUndefined();
    expect(llm.defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("a pre-existing defaultProvider wins and the blob still goes", () => {
    const workspace = setup();
    writeConfig(workspace, {
      llm: {
        default: { provider: "openai" },
        defaultProvider: { provider: "cadet" },
      },
    });
    dropLlmDefaultBlobMigration.run(workspace);
    const llm = readConfig(workspace).llm;
    expect(llm.default).toBeUndefined();
    expect(llm.defaultProvider).toEqual({ provider: "cadet" });
  });

  test("an invalid blob provider leaves defaultProvider unset", () => {
    const workspace = setup();
    writeConfig(workspace, {
      llm: { default: { provider: "not-a-provider" } },
    });
    dropLlmDefaultBlobMigration.run(workspace);
    const llm = readConfig(workspace).llm;
    expect(llm.default).toBeUndefined();
    expect(llm.defaultProvider).toBeUndefined();
  });

  test("a config without the blob is untouched", () => {
    const workspace = setup();
    writeConfig(workspace, {
      llm: { defaultProvider: { provider: "cadet" } },
    });
    dropLlmDefaultBlobMigration.run(workspace);
    const llm = readConfig(workspace).llm;
    expect(llm.defaultProvider).toEqual({ provider: "cadet" });
    expect(llm.default).toBeUndefined();
  });

  test("missing and malformed config.json files are no-ops", () => {
    const missing = setup();
    dropLlmDefaultBlobMigration.run(missing);
    expect(existsSync(join(missing, "config.json"))).toBe(false);

    const malformed = setup();
    writeFileSync(join(malformed, "config.json"), "{not json");
    dropLlmDefaultBlobMigration.run(malformed);
    expect(readFileSync(join(malformed, "config.json"), "utf-8")).toBe(
      "{not json",
    );
  });
});
