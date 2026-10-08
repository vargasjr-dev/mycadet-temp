/**
 * Core path helpers for the gateway module.
 *
 * These live in their own file (rather than credential-reader.ts) so that
 * lightweight consumers like CLI scripts can resolve workspace / root paths
 * without pulling in the full credential-reader dependency tree.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { assertTestPathIsEphemeral } from "@mycadet/environments/test-path-guard";

/**
 * XDG data home for cadet state that outlives the process. The fallback for
 * every state dir below resolves here — never into the checkout — so running
 * a service from the repo root cannot litter the worktree.
 */
export function cadetDataHome(): string {
  return (
    process.env.XDG_DATA_HOME?.trim() ||
    join(homedir(), ".local", "share", "cadet")
  );
}

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
 * back to the XDG data home (`~/.local/share/cadet/workspace`) — never the
 * cwd, so a bare run from anywhere (including the repo root) cannot write
 * state into the checkout.
 */
export function getWorkspaceDir(): string {
  const override = process.env.CADET_WORKSPACE_DIR?.trim();
  const dir = override || join(cadetDataHome(), "workspace");
  assertTestPathIsEphemeral(dir, WORKSPACE_GUARD);
  return dir;
}

/**
 * The gateway-security fallback used when GATEWAY_SECURITY_DIR is unset —
 * exported so the test-isolation guard in db/connection.ts can mirror the
 * real-dir check against the same path.
 */
export function defaultGatewaySecurityDir(): string {
  return join(cadetDataHome(), "gateway-security");
}

/**
 * Directory containing files private to the gateway container.
 *
 * In Docker, this is a dedicated volume mounted at /gateway-security via the
 * GATEWAY_SECURITY_DIR env var. Otherwise falls back to the XDG data home —
 * never the cwd, so a bare run from anywhere (including the repo root)
 * cannot write state into the checkout.
 */
export function getGatewaySecurityDir(): string {
  const override = process.env.GATEWAY_SECURITY_DIR?.trim();
  const dir = override || defaultGatewaySecurityDir();
  assertTestPathIsEphemeral(dir, SECURITY_GUARD);
  return dir;
}
