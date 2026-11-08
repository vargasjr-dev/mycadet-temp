/**
 * Gateway proxy endpoints for OAuth app and connection management routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("oauth-apps-proxy");

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
      "OAuth apps proxy upstream error",
    );
  } else if (response.status >= 400) {
    log.warn(
      { path: upstreamPath, status: response.status, duration },
      "OAuth apps proxy upstream error",
    );
  } else {
    log.info(
      { path: upstreamPath, status: response.status, duration },
      "OAuth apps proxy completed",
    );
  }

  return response;
}

export async function handleListApps(req: Request): Promise<Response> {
  return proxyToRuntime(req, "/v1/oauth/apps", new URL(req.url).search);
}

export async function handleCreateApp(req: Request): Promise<Response> {
  return proxyToRuntime(req, "/v1/oauth/apps", "");
}

export async function handleDeleteApp(
  req: Request,
  appId: string,
): Promise<Response> {
  return proxyToRuntime(req, `/v1/oauth/apps/${appId}`, "");
}

export async function handleListConnections(
  req: Request,
  appId: string,
): Promise<Response> {
  return proxyToRuntime(req, `/v1/oauth/apps/${appId}/connections`, "");
}

export async function handleDeleteConnection(
  req: Request,
  connectionId: string,
): Promise<Response> {
  return proxyToRuntime(req, `/v1/oauth/connections/${connectionId}`, "");
}

export async function handleConnect(
  req: Request,
  appId: string,
): Promise<Response> {
  return proxyToRuntime(req, `/v1/oauth/apps/${appId}/connect`, "");
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/oauth/apps",
    method: "get",
    auth: "edge-scoped",
    scope: "settings.read",
    handler: (req) => handleListApps(req),
  },
  {
    path: "/oauth/apps",
    method: "post",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req) => handleCreateApp(req),
  },
  {
    path: /^\/oauth\/apps\/([^/]+)\/?$/,
    method: "delete",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, params) => handleDeleteApp(req, params[0]!),
  },
  {
    path: /^\/oauth\/apps\/([^/]+)\/connections\/?$/,
    method: "get",
    auth: "edge-scoped",
    scope: "settings.read",
    handler: (req, params) => handleListConnections(req, params[0]!),
  },
  {
    path: /^\/oauth\/connections\/([^/]+)\/?$/,
    method: "delete",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, params) => handleDeleteConnection(req, params[0]!),
  },
  {
    path: /^\/oauth\/apps\/([^/]+)\/connect\/?$/,
    method: "post",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, params) => handleConnect(req, params[0]!),
  },
];
