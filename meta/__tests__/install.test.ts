/**
 * Smoke test for the recommended install.sh script.
 *
 * Runs the install script (including `cadet hatch`) and then validates
 * that `cadet ps` reports the hatched assistant. Retires the assistant
 * at the end to clean up.
 *
 * Skipped by default — the install script pulls the latest *published*
 * release, so it can't validate the current (unreleased) version.
 */

import { execSync } from "child_process";
import path from "path";

import { describe, expect, test } from "bun:test";

const INSTALL_SCRIPT = path.resolve(
  __dirname,
  "../../cli/src/adapters/install.sh",
);

describe.skip("install.sh", () => {
  test("installs cadet CLI and cadet ps works", () => {
    /**
     * Tests that the install.sh script successfully installs the CLI
     * and that `cadet ps` produces valid output afterward.
     */

    const shellEnv = {
      ...process.env,
      HOME: process.env.HOME ?? "/root",
    };

    // GIVEN the recommended install.sh script
    // WHEN we run the install script (which includes cadet hatch)
    execSync(`bash "${INSTALL_SCRIPT}" && . ~/.config/cadet/env`, {
      stdio: "inherit",
      timeout: 300_000,
      shell: "/bin/bash",
      env: shellEnv,
    });

    // THEN `cadet ps` should run successfully and report one assistant
    const psOutput = execSync(`cadet ps`, {
      encoding: "utf-8",
      timeout: 30_000,
      shell: "/bin/bash",
      env: shellEnv,
    });

    expect(psOutput).toMatch(/NAME\s+STATUS\s+INFO/);

    // AND we retire the assistant to clean up
    const lines = psOutput
      .split("\n")
      .filter(
        (l) => l.trim() && !l.includes("NAME") && !l.startsWith("  -"),
      );
    const assistantName = lines[0]?.trim().split(/\s{2,}/)[0];

    if (assistantName) {
      execSync(`cadet retire ${assistantName}`, {
        stdio: "inherit",
        timeout: 30_000,
        shell: "/bin/bash",
        env: shellEnv,
      });
    }
  });
});
