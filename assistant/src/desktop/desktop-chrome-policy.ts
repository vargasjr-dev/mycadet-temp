import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getErrorCode } from "../util/error-details.js";
import { isPlainObject } from "../util/object.js";

export function writeDesktopChromePolicy(policyDir: string): void {
  const path = join(policyDir, "cadet-desktop.json");
  let policy: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(value)) {
      throw new Error("Desktop Chrome policy must be a JSON object");
    }
    policy = value;
  } catch (err) {
    if (getErrorCode(err) !== "ENOENT") {
      throw err;
    }
  }
  if (
    policy.NetworkPredictionOptions === 2 &&
    policy.CommandLineFlagSecurityWarningsEnabled === false &&
    policy.PasswordManagerEnabled === false &&
    policy.HighEfficiencyModeEnabled === true &&
    policy.MemorySaverModeSavings === 1
  ) {
    return;
  }

  policy.NetworkPredictionOptions = 2;
  // This suppresses command-line warnings; Chrome's sandbox stays unchanged.
  policy.CommandLineFlagSecurityWarningsEnabled = false;
  // Suppress save prompts while keeping previously saved passwords usable.
  policy.PasswordManagerEnabled = false;
  policy.HighEfficiencyModeEnabled = true;
  policy.MemorySaverModeSavings = 1;
  mkdirSync(policyDir, { recursive: true });
  const staging = mkdtempSync(join(policyDir, ".cadet-desktop-"));
  try {
    const temporaryPath = join(staging, "policy.json");
    writeFileSync(temporaryPath, JSON.stringify(policy, null, 2) + "\n", {
      mode: 0o644,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
