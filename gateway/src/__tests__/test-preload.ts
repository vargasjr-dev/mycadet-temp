/**
 * Shared test preload — runs before every gateway test file.
 *
 * Creates a per-file temporary directory tree and sets GATEWAY_SECURITY_DIR,
 * CADET_WORKSPACE_DIR, and GATEWAY_IPC_SOCKET_DIR so that gateway code resolves
 * under the temp dir instead of the real ~/.cadet paths.
 *
 * Exports:
 *   testSecurityDir  — the per-file temp GATEWAY_SECURITY_DIR
 *   testWorkspaceDir — the per-file temp CADET_WORKSPACE_DIR
 *   testIpcSocketDir — the per-file temp GATEWAY_IPC_SOCKET_DIR
 *
 * These are safe to import from any test file:
 *
 *   import { testSecurityDir, testWorkspaceDir } from "./test-preload.js";
 *
 * Cleanup: the temp dir tree is removed after all tests in the file complete.
 * The original env vars are restored so that back-to-back test files in the
 * same process (if Bun ever batches them) don't leak state.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

// ---------------------------------------------------------------------------
// Create isolated directory tree
// ---------------------------------------------------------------------------

const testRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "cadet-gateway-test-")),
);

export const testSecurityDir = join(testRoot, "protected");
export const testWorkspaceDir = join(testRoot, "workspace");
export const testIpcSocketDir = join(testRoot, "ipc");

mkdirSync(testSecurityDir, { recursive: true });
mkdirSync(testWorkspaceDir, { recursive: true });
mkdirSync(testIpcSocketDir, { recursive: true });

// ---------------------------------------------------------------------------
// Save originals and set env vars
// ---------------------------------------------------------------------------

const savedSecurityDir = process.env.GATEWAY_SECURITY_DIR;
const savedWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
const savedIpcSocketDir = process.env.GATEWAY_IPC_SOCKET_DIR;
const savedCesCredentialUrl = process.env.CES_CREDENTIAL_URL;
const savedCesServiceToken = process.env.CES_SERVICE_TOKEN;

process.env.GATEWAY_SECURITY_DIR = testSecurityDir;
process.env.CADET_WORKSPACE_DIR = testWorkspaceDir;
// Pin the gateway IPC socket dir to the per-file temp tree. Without this,
// a developer environment that exports GATEWAY_IPC_SOCKET_DIR (e.g. the
// docker topology's /run/gateway-ipc) leaks into GatewayIpcServer tests,
// whose listen() removes and re-binds the socket at the PRODUCTION path —
// hijacking the live gateway's IPC (permission prompts) for the duration
// of the test run. CI never sees this because it does not export the var,
// so resolution falls back to the (sandboxed) workspace path.
process.env.GATEWAY_IPC_SOCKET_DIR = testIpcSocketDir;

// Prevent tests from hitting a real CES sidecar that may be running
// in the sandbox. Without this, readCredential() resolves secrets from
// the live credential store instead of test fixtures.
delete process.env.CES_CREDENTIAL_URL;
delete process.env.CES_SERVICE_TOKEN;

// ---------------------------------------------------------------------------
// Restore and cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  if (savedSecurityDir === undefined) {
    delete process.env.GATEWAY_SECURITY_DIR;
  } else {
    process.env.GATEWAY_SECURITY_DIR = savedSecurityDir;
  }

  if (savedWorkspaceDir === undefined) {
    delete process.env.CADET_WORKSPACE_DIR;
  } else {
    process.env.CADET_WORKSPACE_DIR = savedWorkspaceDir;
  }

  if (savedIpcSocketDir === undefined) {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;
  } else {
    process.env.GATEWAY_IPC_SOCKET_DIR = savedIpcSocketDir;
  }

  if (savedCesCredentialUrl === undefined) {
    delete process.env.CES_CREDENTIAL_URL;
  } else {
    process.env.CES_CREDENTIAL_URL = savedCesCredentialUrl;
  }

  if (savedCesServiceToken === undefined) {
    delete process.env.CES_SERVICE_TOKEN;
  } else {
    process.env.CES_SERVICE_TOKEN = savedCesServiceToken;
  }

  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
