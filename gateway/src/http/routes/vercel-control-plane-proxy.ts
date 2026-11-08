/**
 * Gateway proxy endpoints for Vercel integration control-plane routes.
 *
 * These routes forward GET/POST/DELETE requests for Vercel API token
 * management to the assistant runtime, ensuring all client traffic
 * goes through the gateway as required by AGENTS.md.
 */

import { proxyForward } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

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
let routeProxyImpl: ReturnType<typeof createVercelControlPlaneProxyHandler> | undefined;


/** Built on first request — module import stays side-effect-free. */
function routeProxy(): ReturnType<typeof createVercelControlPlaneProxyHandler> {
  return (routeProxyImpl ??= createVercelControlPlaneProxyHandler(getConfig()));
}


export const ROUTES: RouteDefinition[] = [
  {
    path: "/integrations/vercel/config",
    method: "get",
    auth: "edge-scoped",
    scope: "settings.read",
    handler: (req, _params) => routeProxy().handleGetVercelConfig(req),
  },
  {
    path: "/integrations/vercel/config",
    method: "post",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, _params) => routeProxy().handleSetVercelConfig(req),
  },
  {
    path: "/integrations/vercel/config",
    method: "delete",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, _params) => routeProxy().handleDeleteVercelConfig(req),
  },
];
