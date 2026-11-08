/**
 * Gateway proxy endpoints for channel verification session control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("channel-verification-session-proxy");

/**
 * Build a request with the correct `x-forwarded-for` header for upstream
 * forwarding. The runtime uses this header to enforce loopback-only checks.
 *
 * - If `clientIp` is provided and is not loopback, set the header.
 * - Otherwise, strip any client-supplied value to prevent spoofing.
 */
function withForwardedFor(req: Request, clientIp?: string): Request {
  const headers = new Headers(req.headers);
  if (clientIp && !isLoopbackAddress(clientIp)) {
    headers.set("x-forwarded-for", clientIp);
  } else {
    headers.delete("x-forwarded-for");
  }
  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error -- Bun supports duplex on Request but the types lag
    duplex: "half",
  });
}

export function createChannelVerificationSessionProxyHandler(
  config: GatewayConfig,
) {
  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
    clientIp?: string,
  ): Promise<Response> {
    const prepared = withForwardedFor(req, clientIp);
    const start = performance.now();
    const response = await proxyForwardToResponse(prepared, {
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
        "Channel verification session proxy upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { path: upstreamPath, status: response.status, duration },
        "Channel verification session proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: response.status, duration },
        "Channel verification session proxy completed",
      );
    }

    return response;
  }

  return {
    async handleCreateVerificationSession(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/channel-verification-sessions", "");
    },

    async handleResendVerificationSession(req: Request): Promise<Response> {
      return proxyToRuntime(
        req,
        "/v1/channel-verification-sessions/resend",
        "",
      );
    },

    async handleCancelVerificationSession(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/channel-verification-sessions", "");
    },

    async handleRevokeVerificationBinding(req: Request): Promise<Response> {
      return proxyToRuntime(
        req,
        "/v1/channel-verification-sessions/revoke",
        "",
      );
    },

    async handleGetVerificationStatus(req: Request): Promise<Response> {
      const url = new URL(req.url);
      return proxyToRuntime(
        req,
        "/v1/channel-verification-sessions/status",
        url.search,
      );
    },
  };
}

let routeProxyImpl: ReturnType<typeof createChannelVerificationSessionProxyHandler> | undefined;


/** Built on first request — module import stays side-effect-free. */
function routeProxy(): ReturnType<typeof createChannelVerificationSessionProxyHandler> {
  return (routeProxyImpl ??= createChannelVerificationSessionProxyHandler(getConfig()));
}


export const ROUTES: RouteDefinition[] = [
  {
    path: "/channel-verification-sessions",
    method: "post",
    auth: "edge",
    handler: (req, _params) =>
      routeProxy().handleCreateVerificationSession(req),
  },
  {
    path: "/channel-verification-sessions",
    method: "delete",
    auth: "edge",
    handler: (req, _params) =>
      routeProxy().handleCancelVerificationSession(req),
  },
  {
    path: "/channel-verification-sessions/resend",
    method: "post",
    auth: "edge",
    handler: (req, _params) =>
      routeProxy().handleResendVerificationSession(req),
  },
  {
    path: "/channel-verification-sessions/status",
    method: "get",
    auth: "edge",
    handler: (req, _params) =>
      routeProxy().handleGetVerificationStatus(req),
  },
  {
    path: "/channel-verification-sessions/revoke",
    method: "post",
    auth: "edge",
    handler: (req, _params) =>
      routeProxy().handleRevokeVerificationBinding(req),
  },
];
