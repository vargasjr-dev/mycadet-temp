/**
 * Gateway proxy endpoints for Twilio integration control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForward } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("twilio-control-plane-proxy");

export function createTwilioControlPlaneProxyHandler(config: GatewayConfig) {
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
          ? "Twilio control-plane proxy upstream timed out"
          : "Twilio control-plane proxy upstream connection failed",
      );
    } else if (result.status >= 400) {
      log.warn(
        { path: upstreamPath, status: result.status, duration },
        "Twilio control-plane proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: result.status, duration },
        "Twilio control-plane proxy completed",
      );
    }

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  return {
    async handleGetTwilioConfig(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/twilio/config");
    },

    async handleSetTwilioCredentials(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/twilio/credentials");
    },

    async handleClearTwilioCredentials(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/twilio/credentials");
    },

    async handleListTwilioNumbers(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/twilio/numbers");
    },

    async handleProvisionTwilioNumber(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/twilio/numbers/provision");
    },

    async handleAssignTwilioNumber(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/twilio/numbers/assign");
    },

    async handleReleaseTwilioNumber(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/twilio/numbers/release");
    },
  };
}

let routeProxyImpl: ReturnType<typeof createTwilioControlPlaneProxyHandler> | undefined;


/** Built on first request — module import stays side-effect-free. */
function routeProxy(): ReturnType<typeof createTwilioControlPlaneProxyHandler> {
  return (routeProxyImpl ??= createTwilioControlPlaneProxyHandler(getConfig()));
}


export const ROUTES: RouteDefinition[] = [
  {
    path: "/integrations/twilio/config",
    method: "get",
    auth: "edge",
    handler: (req, _params) => routeProxy().handleGetTwilioConfig(req),
  },
  {
    path: "/integrations/twilio/credentials",
    method: "post",
    auth: "edge",
    handler: (req, _params) => routeProxy().handleSetTwilioCredentials(req),
  },
  {
    path: "/integrations/twilio/credentials",
    method: "delete",
    auth: "edge",
    handler: (req, _params) =>
      routeProxy().handleClearTwilioCredentials(req),
  },
  {
    path: "/integrations/twilio/numbers",
    method: "get",
    auth: "edge",
    handler: (req, _params) => routeProxy().handleListTwilioNumbers(req),
  },
  {
    path: "/integrations/twilio/numbers/provision",
    method: "post",
    auth: "edge",
    handler: (req, _params) =>
      routeProxy().handleProvisionTwilioNumber(req),
  },
  {
    path: "/integrations/twilio/numbers/assign",
    method: "post",
    auth: "edge",
    handler: (req, _params) => routeProxy().handleAssignTwilioNumber(req),
  },
  {
    path: "/integrations/twilio/numbers/release",
    method: "post",
    auth: "edge",
    handler: (req, _params) => routeProxy().handleReleaseTwilioNumber(req),
  },
];
