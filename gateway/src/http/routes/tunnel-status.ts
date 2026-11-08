/**
 * Tunnel status endpoint (GET /v1/tunnel/status).
 *
 * Exposes the in-process TunnelClient state over HTTP so web clients
 * and the CLI can query tunnel connectivity without a custom IPC call.
 * Returns { connected: false, publicUrl: null } when Tunnel is not configured
 * (TUNNEL_BASE_URL not set).
 */

import { getTunnelClient, type TunnelClient } from "../../tunnel/client.js";
import type { RouteDefinition } from "./types.js";

export interface TunnelStatusResponse {
  connected: boolean;
  publicUrl: string | null;
}

export function createTunnelStatusHandler(
  tunnelClient: TunnelClient | undefined,
) {
  function handleTunnelStatus(): Response {
    const status: TunnelStatusResponse = tunnelClient?.getStatus() ?? {
      connected: false,
      publicUrl: null,
    };
    return Response.json(status);
  }

  return { handleTunnelStatus };
}

// Assistant-scoped mirror: self-hosted clients emit /v1/assistants/<id>/tunnel/status
// and rewriteForSelfHostedIngress preserves that path, so a flat-only route
// would fall through to the runtime proxy and 404.
/** Built on first request — module import stays side-effect-free. */
let routeProxyImpl: ReturnType<typeof createTunnelStatusHandler> | undefined;
function routeProxy(): ReturnType<typeof createTunnelStatusHandler> {
  return (routeProxyImpl ??= createTunnelStatusHandler(getTunnelClient()));
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/tunnel/status",
    method: "get",
    auth: "edge",
    handler: (_req, _params) => routeProxy().handleTunnelStatus(),
  },
  {
    path: /^\/assistants\/[^/]+\/tunnel\/status\/?$/,
    method: "get",
    auth: "edge-scoped",
    handler: (_req, _params) => routeProxy().handleTunnelStatus(),
  },
];
