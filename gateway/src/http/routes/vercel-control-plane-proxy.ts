/**
 * Gateway proxy endpoints for Vercel integration control-plane routes.
 *
 * These routes forward GET/POST/DELETE requests for Vercel API token
 * management to the assistant runtime, ensuring all client traffic
 * goes through the gateway as required by AGENTS.md.
 */

import { proxyForward } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

const log = getLogger("vercel-control-plane-proxy");

export function createVercelControlPlaneProxyHandler(config: GatewayConfig) {
  async function forward(
    req: Request,
    upstreamPath: string,
    upstreamSearch?: string,
  ): Promise<Response> {
    const start = performance.now();
    const result = await proxyForward(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: upstreamSearch,
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });

    const duration = Math.round(performance.now() - start);

    if (result.gatewayError) {
      log.error(
        { path: upstreamPath, duration },
        result.status === 504
          ? "Vercel control-plane proxy upstream timed out"
          : "Vercel control-plane proxy upstream connection failed",
      );
    } else if (result.status >= 400) {
      log.warn(
        { path: upstreamPath, status: result.status, duration },
        "Vercel control-plane proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: result.status, duration },
        "Vercel control-plane proxy completed",
      );
    }

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  return {
    async handleGetVercelConfig(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/vercel/config");
    },

    async handleSetVercelConfig(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/vercel/config");
    },

    async handleDeleteVercelConfig(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/vercel/config");
    },
  };
}

// The dedicated proxy mints a gateway service token, so the daemon
// never sees the caller's scopes. Edge-scoped auth is the check.
const routeProxy = lazyRef<
  ReturnType<typeof createVercelControlPlaneProxyHandler>
>("Vercel control-plane proxy used before initialization");

export function initVercelControlPlaneRoutes(config: GatewayConfig): void {
  routeProxy.set(createVercelControlPlaneProxyHandler(config));
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/integrations/vercel/config",
    method: "get",
    auth: "edge-scoped",
    scope: "settings.read",
    handler: (req, _params) => routeProxy.get().handleGetVercelConfig(req),
  },
  {
    path: "/integrations/vercel/config",
    method: "post",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, _params) => routeProxy.get().handleSetVercelConfig(req),
  },
  {
    path: "/integrations/vercel/config",
    method: "delete",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, _params) => routeProxy.get().handleDeleteVercelConfig(req),
  },
];
