/**
 * Gateway proxy endpoint for runtime health checks.
 *
 * Exposes GET /v1/health as a dedicated gateway route with explicit
 * auth handling.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

const log = getLogger("runtime-health-proxy");

export function createRuntimeHealthProxyHandler(config: GatewayConfig) {
  async function handleRuntimeHealth(req: Request): Promise<Response> {
    const start = performance.now();
    const response = await proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: "/v1/health",
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
    const duration = Math.round(performance.now() - start);

    if (response.status >= 500) {
      log.error(
        { status: response.status, duration },
        "Runtime health proxy upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { status: response.status, duration },
        "Runtime health proxy upstream error",
      );
    } else {
      log.info(
        { status: response.status, duration },
        "Runtime health proxy completed",
      );
    }

    return response;
  }

  return { handleRuntimeHealth };
}

const routeProxy = lazyRef<ReturnType<typeof createRuntimeHealthProxyHandler>>(
  "Runtime health proxy used before initialization",
);

export function initRuntimeHealthRoutes(config: GatewayConfig): void {
  routeProxy.set(createRuntimeHealthProxyHandler(config));
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/health",
    method: "get",
    auth: "edge",
    handler: (req, _params) => routeProxy.get().handleRuntimeHealth(req),
  },
  {
    path: "/healthz",
    method: "get",
    auth: "edge",
    handler: (req, _params) => routeProxy.get().handleRuntimeHealth(req),
  },
];
