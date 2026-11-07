/**
 * Gateway proxy for the daemon rollback-migrations control-plane endpoint.
 *
 * Follows the same forwarding pattern as workspace-commit-proxy.ts:
 * strips hop-by-hop headers, replaces the client's edge JWT with a
 * minted service token, and proxies the request to the daemon.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getAssistantBaseUrl } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("migration-rollback-proxy");

/** Timeout for migration rollback requests (120 seconds) — rollbacks can be slow when many migrations have complex down() functions. */
const MIGRATION_ROLLBACK_TIMEOUT_MS = 120_000;

export function createMigrationRollbackProxyHandler() {
  return async function handleMigrationRollback(
    req: Request,
  ): Promise<Response> {
    const start = performance.now();

    const response = await proxyForwardToResponse(req, {
      baseUrl: getAssistantBaseUrl(),
      path: "/v1/admin/rollback-migrations",
      timeoutMs: MIGRATION_ROLLBACK_TIMEOUT_MS,
      fetchImpl,
    });

    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      log.warn(
        { status: response.status, duration },
        "Migration rollback proxy upstream error",
      );
    } else {
      log.info(
        { status: response.status, duration },
        "Migration rollback proxy completed",
      );
    }

    return response;
  };
}
