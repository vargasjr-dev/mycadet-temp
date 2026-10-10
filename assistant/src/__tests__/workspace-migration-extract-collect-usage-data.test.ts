import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { extractCollectUsageDataMigration } from "../workspace/migrations/004-extract-collect-usage-data.js";

// Real fs: each test runs the migration against a fresh temp workspace and
// asserts on the file state it leaves behind.
let WORKSPACE_DIR: string;
const CONFIG_PATH = () => join(WORKSPACE_DIR, "config.json");
const FLAG_KEY = "feature_flags.collect-usage-data.enabled";

function setupConfig(config: unknown): void {
  writeFileSync(CONFIG_PATH(), JSON.stringify(config));
}

function readConfig(): unknown {
  return JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
}

describe("004-extract-collect-usage-data migration", () => {
  beforeEach(() => {
    WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "mig-004-"));
  });

  afterEach(() => {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("no-op when config.json is absent", () => {
    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(existsSync(CONFIG_PATH())).toBe(false);
  });

  test("no-op when flag not present in assistantFeatureFlagValues", () => {
    setupConfig({
      assistantFeatureFlagValues: {
        "feature_flags.some-other-flag.enabled": true,
      },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(
      (readConfig() as Record<string, unknown>).assistantFeatureFlagValues,
    ).toEqual({ "feature_flags.some-other-flag.enabled": true });
  });

  test("false flag writes collectUsageData: false and removes flag entry", () => {
    setupConfig({ assistantFeatureFlagValues: { [FLAG_KEY]: false } });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.collectUsageData).toBe(false);
    expect(written.assistantFeatureFlagValues).toBeUndefined();
  });

  test("true flag only removes the flag entry (does not write collectUsageData)", () => {
    setupConfig({ assistantFeatureFlagValues: { [FLAG_KEY]: true } });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.collectUsageData).toBeUndefined();
    expect(written.assistantFeatureFlagValues).toBeUndefined();
  });

  test("empty assistantFeatureFlagValues is cleaned up after removing flag", () => {
    setupConfig({
      someSetting: "value",
      assistantFeatureFlagValues: { [FLAG_KEY]: true },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.assistantFeatureFlagValues).toBeUndefined();
    expect(written.someSetting).toBe("value");
  });

  test("other flags in assistantFeatureFlagValues are preserved", () => {
    setupConfig({
      assistantFeatureFlagValues: {
        [FLAG_KEY]: false,
        "feature_flags.some-other-flag.enabled": true,
      },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.collectUsageData).toBe(false);
    const remaining = written.assistantFeatureFlagValues as Record<
      string,
      unknown
    >;
    expect(remaining).toEqual({
      "feature_flags.some-other-flag.enabled": true,
    });
    expect(remaining[FLAG_KEY]).toBeUndefined();
  });

  test("malformed config is handled gracefully", () => {
    writeFileSync(CONFIG_PATH(), "not valid json {{{");

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(readFileSync(CONFIG_PATH(), "utf-8")).toBe("not valid json {{{");
  });

  test("no-op when config is an array", () => {
    setupConfig([1, 2, 3]);

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(readConfig()).toEqual([1, 2, 3]);
  });

  test("no-op when assistantFeatureFlagValues is not an object", () => {
    setupConfig({ assistantFeatureFlagValues: "not-an-object" });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(
      (readConfig() as Record<string, unknown>).assistantFeatureFlagValues,
    ).toBe("not-an-object");
  });

  test("no-op when flag value is not a boolean", () => {
    setupConfig({ assistantFeatureFlagValues: { [FLAG_KEY]: "string-value" } });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(
      (readConfig() as Record<string, unknown>).assistantFeatureFlagValues,
    ).toEqual({ [FLAG_KEY]: "string-value" });
  });
});
