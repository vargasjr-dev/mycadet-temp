/**
 * Gateway proxy endpoints for Slack share control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

const log = getLogger("slack-control-plane-proxy");

export function createSlackControlPlaneProxyHandler(config: GatewayConfig) {
  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
  ): Promise<Response> {
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

  return {
    async handleListSlackChannels(req: Request): Promise<Response> {
      const url = new URL(req.url);
      return proxyToRuntime(req, "/v1/slack/channels", url.search);
    },

    async handleShareToSlack(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/slack/share", "");
    },
  };
}

const routeProxy = lazyRef<
  ReturnType<typeof createSlackControlPlaneProxyHandler>
>("Slack control-plane proxy used before initialization");

export function initSlackControlPlaneRoutes(config: GatewayConfig): void {
  routeProxy.set(createSlackControlPlaneProxyHandler(config));
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/slack/channels",
    method: "get",
    auth: "edge",
    handler: (req, _params) => routeProxy.get().handleListSlackChannels(req),
  },
  {
    path: "/slack/share",
    method: "post",
    auth: "edge",
    handler: (req, _params) => routeProxy.get().handleShareToSlack(req),
  },
];
