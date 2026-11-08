/**
 * Gateway proxy endpoints for Vercel integration control-plane routes.
 *
 * These routes forward GET/POST/DELETE requests for Vercel API token
 * management to the assistant runtime, ensuring all client traffic
 * goes through the gateway as required by AGENTS.md.
 */

import { proxyForward } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("vercel-control-plane-proxy");

async function forward(
  req: Request,
  upstreamPath: string,
  upstreamSearch?: string,
): Promise<Response> {
  const config = getConfig();
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

// The dedicated proxy mints a gateway service token, so the daemon
// never sees the caller's scopes. Edge-scoped auth is the check.
export function handleGetVercelConfig(req: Request): Promise<Response> {
  return forward(req, "/v1/integrations/vercel/config");
}

export function handleSetVercelConfig(req: Request): Promise<Response> {
  return forward(req, "/v1/integrations/vercel/config");
}

export function handleDeleteVercelConfig(req: Request): Promise<Response> {
  return forward(req, "/v1/integrations/vercel/config");
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/integrations/vercel/config",
    method: "get",
    auth: "edge-scoped",
    scope: "settings.read",
    handler: (req) => handleGetVercelConfig(req),
  },
  {
    path: "/integrations/vercel/config",
    method: "post",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req) => handleSetVercelConfig(req),
  },
  {
    path: "/integrations/vercel/config",
    method: "delete",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req) => handleDeleteVercelConfig(req),
  },
];
