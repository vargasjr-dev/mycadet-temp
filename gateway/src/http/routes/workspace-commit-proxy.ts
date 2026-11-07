/**
 * Gateway proxy for the daemon workspace-commit control-plane endpoint.
 *
 * Follows the same forwarding pattern as upgrade-broadcast-proxy.ts:
 * strips hop-by-hop headers, replaces the client's edge JWT with a
 * minted service token, and proxies the request to the daemon.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

const log = getLogger("workspace-commit-proxy");

export function createWorkspaceCommitProxyHandler(config: GatewayConfig) {
  return async function handleWorkspaceCommit(req: Request): Promise<Response> {
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
  };
}

const routeProxy = lazyRef<
  ReturnType<typeof createWorkspaceCommitProxyHandler>
>("Workspace commit proxy used before initialization");

export function initWorkspaceCommitRoutes(config: GatewayConfig): void {
  routeProxy.set(createWorkspaceCommitProxyHandler(config));
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/admin/workspace-commit",
    method: "post",
    auth: "edge-scoped",
    scope: "admin.write",
    handler: (req) => routeProxy.get()(req),
  },
];
