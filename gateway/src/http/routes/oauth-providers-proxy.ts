/**
 * Gateway proxy endpoints for OAuth provider discovery routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("oauth-providers-proxy");

async function proxyToRuntime(
  req: Request,
  upstreamPath: string,
  upstreamSearch: string,
): Promise<Response> {
  const config = getConfig();
  const start = performance.now();
  const response = await proxyForwardToResponse(req, {
    baseUrl: config.assistantRuntimeBaseUrl,
    path: upstreamPath,
    search: upstreamSearch || undefined,
    timeoutMs: config.runtimeTimeoutMs,
    fetchImpl,
  });
  const duration = Math.round(performance.now() - start);

  if (response.status >= 500) {
    log.error(
      { path: upstreamPath, status: response.status, duration },
      "OAuth providers proxy upstream error",
    );
  } else if (response.status >= 400) {
    log.warn(
      { path: upstreamPath, status: response.status, duration },
      "OAuth providers proxy upstream error",
    );
  } else {
    log.info(
      { path: upstreamPath, status: response.status, duration },
      "OAuth providers proxy completed",
    );
  }

  return response;
}

export async function handleListProviders(req: Request): Promise<Response> {
  return proxyToRuntime(req, "/v1/oauth/providers", new URL(req.url).search);
}

export async function handleGetProvider(
  req: Request,
  providerKey: string,
): Promise<Response> {
  return proxyToRuntime(req, `/v1/oauth/providers/${providerKey}`, "");
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/oauth/providers",
    method: "get",
    auth: "edge-scoped",
    scope: "settings.read",
    handler: (req) => handleListProviders(req),
  },
  {
    path: /^\/oauth\/providers\/([^/]+)\/?$/,
    method: "get",
    auth: "edge-scoped",
    scope: "settings.read",
    handler: (req, params) => handleGetProvider(req, params[0]!),
  },
];
