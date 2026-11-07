/**
 * Gateway proxy for the daemon upgrade-broadcast control-plane endpoint.
 *
 * Follows the same forwarding pattern as channel-readiness-proxy.ts:
 * strips hop-by-hop headers, replaces the client's edge JWT with a
 * minted service token, and proxies the request to the daemon.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

const log = getLogger("upgrade-broadcast-proxy");

export function createUpgradeBroadcastProxyHandler(config: GatewayConfig) {
  return async function handleUpgradeBroadcast(
    req: Request,
  ): Promise<Response> {
    const start = performance.now();

    const response = await proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: "/v1/admin/upgrade-broadcast",
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });

    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      log.warn(
        { status: response.status, duration },
        "Upgrade broadcast proxy upstream error",
      );
    } else {
      log.info(
        { status: response.status, duration },
        "Upgrade broadcast proxy completed",
      );
    }

    return response;
  };
}

const routeProxy = lazyRef<
  ReturnType<typeof createUpgradeBroadcastProxyHandler>
>("Upgrade broadcast proxy used before initialization");

export function initUpgradeBroadcastRoutes(config: GatewayConfig): void {
  routeProxy.set(createUpgradeBroadcastProxyHandler(config));
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/admin/upgrade-broadcast",
    method: "post",
    auth: "edge-scoped",
    scope: "admin.write",
    handler: (req) => routeProxy.get()(req),
  },
];
