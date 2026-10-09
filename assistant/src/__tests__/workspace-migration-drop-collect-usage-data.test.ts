import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dropCollectUsageDataMigration } from "../workspace/migrations/106-drop-collect-usage-data.js";

// Real fs: each test runs the migration against a fresh temp workspace and
// asserts on the file state it leaves behind.
let WORKSPACE_DIR: string;
const CONFIG_PATH = () => join(WORKSPACE_DIR, "config.json");

function setupConfig(config: unknown): void {
  writeFileSync(CONFIG_PATH(), JSON.stringify(config));
}

function readConfig(): unknown {
  return JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
}

describe("106-drop-collect-usage-data migration", () => {
  beforeEach(() => {
    WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "mig-106-"));
  });

  afterEach(() => {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("no-op when config.json is absent", () => {
    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(existsSync(CONFIG_PATH())).toBe(false);
  });

  test("explicit opt-out is preserved as legacyTelemetryOptOut", () => {
    setupConfig({ collectUsageData: false, someSetting: "value" });

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.collectUsageData).toBeUndefined();
    expect(written.legacyTelemetryOptOut).toBe(true);
    expect(written.someSetting).toBe("value");
  });

  test("collectUsageData: true is removed without setting the marker", () => {
    setupConfig({ collectUsageData: true });

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.collectUsageData).toBeUndefined();
    expect(written.legacyTelemetryOptOut).toBeUndefined();
  });

  test("non-false value is removed without setting the marker", () => {
    setupConfig({ collectUsageData: "yes" });

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.collectUsageData).toBeUndefined();
    expect(written.legacyTelemetryOptOut).toBeUndefined();
  });

  test("no-op when collectUsageData is absent (no marker)", () => {
    setupConfig({ someSetting: "value" });

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(readConfig()).toEqual({ someSetting: "value" });
  });

  test("malformed config is handled gracefully", () => {
    writeFileSync(CONFIG_PATH(), "not valid json {{{");

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(readFileSync(CONFIG_PATH(), "utf-8")).toBe("not valid json {{{");
  });

  test("no-op when config is an array", () => {
    setupConfig([1, 2, 3]);

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(readConfig()).toEqual([1, 2, 3]);
  });
});
