/**
 * Gateway proxy for the daemon workspace-commit control-plane endpoint.
 *
 * Follows the same forwarding pattern as upgrade-broadcast-proxy.ts:
 * strips hop-by-hop headers, replaces the client's edge JWT with a
 * minted service token, and proxies the request to the daemon.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("workspace-commit-proxy");

export async function handleWorkspaceCommit(req: Request): Promise<Response> {
  const config = getConfig();
  const start = performance.now();

  const response = await proxyForwardToResponse(req, {
    baseUrl: config.assistantRuntimeBaseUrl,
    path: "/v1/admin/workspace-commit",
    timeoutMs: config.runtimeTimeoutMs,
    fetchImpl,
  });

  const duration = Math.round(performance.now() - start);

  if (response.status >= 400) {
    log.warn(
      { status: response.status, duration },
      "Workspace commit proxy upstream error",
    );
  } else {
    log.info(
      { status: response.status, duration },
      "Workspace commit proxy completed",
    );
  }

  return response;
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/admin/workspace-commit",
    method: "post",
    auth: "edge-scoped",
    scope: "admin.write",
    handler: (req) => handleWorkspaceCommit(req),
  },
];
