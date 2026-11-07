/**
 * Tunnel status endpoint (GET /v1/tunnel/status).
 *
 * Exposes the in-process TunnelClient state over HTTP so web clients
 * and the CLI can query tunnel connectivity without a custom IPC call.
 * Returns { connected: false, publicUrl: null } when Tunnel is not configured
 * (TUNNEL_BASE_URL not set).
 */

import type { TunnelClient } from "../../tunnel/client.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

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
const routeProxy = lazyRef<ReturnType<typeof createTunnelStatusHandler>>(
  "Tunnel status handler used before initialization",
);

export function initTunnelStatusRoutes(
  tunnelClient: TunnelClient | undefined,
): void {
  routeProxy.set(createTunnelStatusHandler(tunnelClient));
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/tunnel/status",
    method: "get",
    auth: "edge",
    handler: (_req, _params) => routeProxy.get().handleTunnelStatus(),
  },
  {
    path: /^\/assistants\/[^/]+\/tunnel\/status\/?$/,
    method: "get",
    auth: "edge-scoped",
    handler: (_req, _params) => routeProxy.get().handleTunnelStatus(),
  },
];
