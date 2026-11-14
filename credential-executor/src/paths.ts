/**
 * CES private data-root layout.
 *
 * Defines the directory structure for CES-private durable state (grants,
 * audit logs, tool store) and CES-private security material (the encrypted
 * store, `keys.enc` + `store.key`). This state is never stored on the
 * assistant-visible workspace/data root — it lives in CES-only paths that
 * the assistant process cannot read or write.
 *
 * Resolution convention (shared with the gateway and the assistant):
 * every directory comes from its env var, falling back to
 * `process.cwd()/<hardcoded-value>`:
 *
 * - `CREDENTIAL_SECURITY_DIR` → `./ces-security`
 * - `CES_DATA_DIR` → `./ces-data`
 *
 * Managed containers set both explicitly (the cloud template provisions
 * `/ces-security` and `/ces-data` volumes); bare-metal runs fall back to
 * the cwd convention. The assistant-visible data root (where
 * workspace, embeddings, etc. live) is a separate path and must never be
 * used for CES-private writes.
 */

import { join } from "node:path";

// ---------------------------------------------------------------------------
// Root directory helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the CES security directory (contains `keys.enc` + `store.key`).
 *
 * Priority:
 * 1. `CREDENTIAL_SECURITY_DIR` env var (set by the cloud template for the
 *    CES container — `/ces-security`)
 * 2. Default: `./ces-security` (cwd fallback convention)
 */
export function getSecurityDir(): string {
  return (
    process.env["CREDENTIAL_SECURITY_DIR"]?.trim() ||
    join(process.cwd(), "ces-security")
  );
}

/**
 * Return the CES-private data root (grants, audit logs, tool store).
 *
 * Priority:
 * 1. `CES_DATA_DIR` env var (set by the cloud template — `/ces-data`)
 * 2. Default: `./ces-data` (cwd fallback convention)
 */
export function getCesDataRoot(): string {
  return process.env["CES_DATA_DIR"]?.trim() || join(process.cwd(), "ces-data");
}

// ---------------------------------------------------------------------------
// Subdirectory layout
// ---------------------------------------------------------------------------

/** Directory for CES log files. */
export function getCesLogDir(): string {
  return join(getCesDataRoot(), "logs");
}

// ---------------------------------------------------------------------------
// CES socket path (local sibling and managed sidecar)
// ---------------------------------------------------------------------------

/**
 * The path to the CES Unix socket used in every environment.
 *
 * Local siblings and managed sidecars share this resolver — it lives in
 * `@mycadet/ces-client/socket-path` so the assistant, gateway, and CLI dial
 * the same path CES binds without depending on this package. The directory
 * comes from `CES_SOCKET_DIR` (default `/run/ces-ipc`) and is a sibling of
 * the CES data dir, never inside it.
 */
export {
  getCesSocketPath,
  getCesSocketDir,
} from "@mycadet/ces-client/socket-path";

// ---------------------------------------------------------------------------
// Health port (managed mode only)
// ---------------------------------------------------------------------------

/** Default health probe port for managed CES. */
const DEFAULT_HEALTH_PORT = 8090;

/**
 * Return the health probe port for managed mode.
 *
 * Health probes are served on a dedicated HTTP port, separate from the
 * Unix socket command transport. This ensures liveness/readiness probes
 * work without a Unix socket client.
 */
export function getHealthPort(): number {
  const envPort = process.env["CES_HEALTH_PORT"];
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HEALTH_PORT;
}
