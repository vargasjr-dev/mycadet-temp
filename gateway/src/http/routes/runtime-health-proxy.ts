/**
 * Gateway proxy endpoint for runtime health checks.
 *
 * Exposes GET /v1/health as a dedicated gateway route with explicit
 * auth handling.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("runtime-health-proxy");

export async function handleRuntimeHealth(req: Request): Promise<Response> {
  const config = getConfig();
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

export const ROUTES: RouteDefinition[] = [
  {
    path: "/health",
    method: "get",
    auth: "edge",
    handler: (req) => handleRuntimeHealth(req),
  },
  {
    path: "/healthz",
    method: "get",
    auth: "edge",
    handler: (req) => handleRuntimeHealth(req),
  },
];
