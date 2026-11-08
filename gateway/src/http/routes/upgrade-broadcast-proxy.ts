/**
 * Gateway proxy for the daemon upgrade-broadcast control-plane endpoint.
 *
 * Follows the same forwarding pattern as channel-readiness-proxy.ts:
 * strips hop-by-hop headers, replaces the client's edge JWT with a
 * minted service token, and proxies the request to the daemon.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

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

let routeProxyImpl: ReturnType<typeof createUpgradeBroadcastProxyHandler> | undefined;


/** Built on first request — module import stays side-effect-free. */
function routeProxy(): ReturnType<typeof createUpgradeBroadcastProxyHandler> {
  return (routeProxyImpl ??= createUpgradeBroadcastProxyHandler(getConfig()));
}


export const ROUTES: RouteDefinition[] = [
  {
    path: "/admin/upgrade-broadcast",
    method: "post",
    auth: "edge-scoped",
    scope: "admin.write",
    handler: (req) => routeProxy()(req),
  },
];
