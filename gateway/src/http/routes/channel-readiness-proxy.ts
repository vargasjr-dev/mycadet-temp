/**
 * Gateway proxy endpoints for channel readiness control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("channel-readiness-proxy");

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
      "Channel readiness proxy upstream error",
    );
  } else if (response.status >= 400) {
    log.warn(
      { path: upstreamPath, status: response.status, duration },
      "Channel readiness proxy upstream error",
    );
  } else {
    log.info(
      { path: upstreamPath, status: response.status, duration },
      "Channel readiness proxy completed",
    );
  }

  return response;
}

export async function handleGetChannelReadiness(
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  return proxyToRuntime(req, "/v1/channels/readiness", url.search);
}

export async function handleRefreshChannelReadiness(
  req: Request,
): Promise<Response> {
  return proxyToRuntime(req, "/v1/channels/readiness/refresh", "");
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/channels/readiness",
    method: "get",
    auth: "edge",
    handler: (req) => handleGetChannelReadiness(req),
  },
  {
    path: "/channels/readiness/refresh",
    method: "post",
    auth: "edge",
    handler: (req) => handleRefreshChannelReadiness(req),
  },
  {
    path: /^\/assistants\/([^/]+)\/channels\/readiness\/$/,
    method: "get",
    auth: "edge",
    handler: (req) => handleGetChannelReadiness(req),
  },
];
