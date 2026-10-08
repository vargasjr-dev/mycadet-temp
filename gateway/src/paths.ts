/**
 * Core path helpers for the gateway module.
 *
 * These live in their own file (rather than credential-reader.ts) so that
 * lightweight consumers like CLI scripts can resolve workspace / root paths
 * without pulling in the full credential-reader dependency tree.
 */

import { join } from "node:path";

import { assertTestPathIsEphemeral } from "@mycadet/environments/test-path-guard";

let warnedWorkspaceDir = false;
let warnedSecurityDir = false;

// In test processes both resolvers below must stay under os.tmpdir():
// gateway code exercised by a test would otherwise read and write live state
// (the gateway DB, the actor-token signing key, the backup key). The guard is
// shared with the assistant in @mycadet/environments/test-path-guard; the
// escape hatches are the same variables the DB-open guard in db/connection.ts
// honors.

const WORKSPACE_GUARD = {
  allowEnvVar: "CADET_ALLOW_REAL_WORKSPACE_IN_TESTS",
  runHint: "Run tests from the gateway package root.",
};

const SECURITY_GUARD = {
  allowEnvVar: "CADET_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS",
  runHint: "Run tests from the gateway package root.",
};

/**
 * Returns the workspace root for user-facing state.
 *
 * When CADET_WORKSPACE_DIR is set, returns that value (used in containerized
 * deployments where the workspace is a separate volume). Otherwise falls
 * back to `<cwd>/workspace` and logs a warning (once).
 */
export function getWorkspaceDir(): string {
  const override = process.env.CADET_WORKSPACE_DIR?.trim();
  if (override) {
    assertTestPathIsEphemeral(override, WORKSPACE_GUARD);
    return override;
  }
  if (!warnedWorkspaceDir) {
    warnedWorkspaceDir = true;
    console.warn(
      "[gateway/paths] CADET_WORKSPACE_DIR is not set — falling back to ./workspace. " +
        "Set CADET_WORKSPACE_DIR explicitly in the entrypoint.",
    );
  }
  const dir = join(process.cwd(), "workspace");
  assertTestPathIsEphemeral(dir, WORKSPACE_GUARD);
  return dir;
}

/**
 * Directory containing files private to the gateway container.
 *
 * In Docker, this is a dedicated volume mounted at /gateway-security via the
 * GATEWAY_SECURITY_DIR env var. Otherwise falls back to
 * `<cwd>/gateway-security` and logs a warning (once).
 */
export function getGatewaySecurityDir(): string {
  const override = process.env.GATEWAY_SECURITY_DIR?.trim();
  if (override) {
    assertTestPathIsEphemeral(override, SECURITY_GUARD);
    return override;
  }
  if (!warnedSecurityDir) {
    warnedSecurityDir = true;
    console.warn(
      "[gateway/paths] GATEWAY_SECURITY_DIR is not set — falling back to ./gateway-security. " +
        "Set GATEWAY_SECURITY_DIR explicitly in the entrypoint.",
    );
  }
  const dir = join(process.cwd(), "gateway-security");
  assertTestPathIsEphemeral(dir, SECURITY_GUARD);
  return dir;
}
