/**
 * Gateway proxy endpoints for Slack share control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("slack-control-plane-proxy");

async function proxyToRuntime(
  req: Request,
  upstreamPath: string,
  upstreamSearch: string,
): Promise<Response> {
  const config = getConfig();
  const start = performance.now();
  const timeoutMs = config.runtimeTimeoutMs;
  const response = await proxyForwardToResponse(req, {
    baseUrl: config.assistantRuntimeBaseUrl,
    path: upstreamPath,
    search: upstreamSearch || undefined,
    timeoutMs,
    fetchImpl,
  });
  const duration = Math.round(performance.now() - start);

  if (response.status >= 500) {
    log.error(
      { path: upstreamPath, status: response.status, duration },
      "Slack control-plane proxy upstream error",
    );
  } else if (response.status >= 400) {
    log.warn(
      { path: upstreamPath, status: response.status, duration },
      "Slack control-plane proxy upstream error",
    );
  } else {
    log.info(
      { path: upstreamPath, status: response.status, duration },
      "Slack control-plane proxy completed",
    );
  }

  return response;
}

export async function handleListSlackChannels(req: Request): Promise<Response> {
  const url = new URL(req.url);
  return proxyToRuntime(req, "/v1/slack/channels", url.search);
}

export async function handleShareToSlack(req: Request): Promise<Response> {
  return proxyToRuntime(req, "/v1/slack/share", "");
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/slack/channels",
    method: "get",
    auth: "edge",
    handler: (req) => handleListSlackChannels(req),
  },
  {
    path: "/slack/share",
    method: "post",
    auth: "edge",
    handler: (req) => handleShareToSlack(req),
  },
];
