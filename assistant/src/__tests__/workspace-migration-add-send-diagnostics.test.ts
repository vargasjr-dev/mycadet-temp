import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { addSendDiagnosticsMigration } from "../workspace/migrations/005-add-send-diagnostics.js";

// Real fs: each test runs the migration against a fresh temp workspace.
let WORKSPACE_DIR: string;
const CONFIG_PATH = () => join(WORKSPACE_DIR, "config.json");

describe("005-add-send-diagnostics migration", () => {
  beforeEach(() => {
    WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "mig-005-"));
  });

  afterEach(() => {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("runs without error when config.json is absent", () => {
    addSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(existsSync(CONFIG_PATH())).toBe(false);
  });

  test("runs without error on existing config (no-op)", () => {
    writeFileSync(CONFIG_PATH(), JSON.stringify({ sendDiagnostics: true }));

    addSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(
      JSON.parse(readFileSync(CONFIG_PATH(), "utf-8")),
    ).toEqual({ sendDiagnostics: true });
  });
});
