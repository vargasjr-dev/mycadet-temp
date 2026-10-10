import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dropSendDiagnosticsMigration } from "../workspace/migrations/107-drop-send-diagnostics.js";

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

describe("107-drop-send-diagnostics migration", () => {
  beforeEach(() => {
    WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "mig-107-"));
  });

  afterEach(() => {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("no-op when config.json is absent", () => {
    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(existsSync(CONFIG_PATH())).toBe(false);
  });

  test("explicit opt-out is preserved as legacyDiagnosticsOptOut", () => {
    setupConfig({ sendDiagnostics: false, someSetting: "value" });

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.sendDiagnostics).toBeUndefined();
    expect(written.legacyDiagnosticsOptOut).toBe(true);
    expect(written.someSetting).toBe("value");
  });

  test("sendDiagnostics: true is removed without setting the marker", () => {
    setupConfig({ sendDiagnostics: true });

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.sendDiagnostics).toBeUndefined();
    expect(written.legacyDiagnosticsOptOut).toBeUndefined();
  });

  test("non-false value is removed without setting the marker", () => {
    setupConfig({ sendDiagnostics: "yes" });

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    const written = readConfig() as Record<string, unknown>;
    expect(written.sendDiagnostics).toBeUndefined();
    expect(written.legacyDiagnosticsOptOut).toBeUndefined();
  });

  test("no-op when sendDiagnostics is absent (no marker)", () => {
    setupConfig({ someSetting: "value" });

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(readConfig()).toEqual({ someSetting: "value" });
  });

  test("malformed config is handled gracefully", () => {
    writeFileSync(CONFIG_PATH(), "not valid json {{{");

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(readFileSync(CONFIG_PATH(), "utf-8")).toBe("not valid json {{{");
  });

  test("no-op when config is an array", () => {
    setupConfig([1, 2, 3]);

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(readConfig()).toEqual([1, 2, 3]);
  });
});
