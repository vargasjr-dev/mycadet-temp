/**
 * Tunnel status endpoint (GET /v1/tunnel/status).
 *
 * Exposes the in-process TunnelClient state over HTTP so web clients
 * and the CLI can query tunnel connectivity without a custom IPC call.
 * Returns { connected: false, publicUrl: null } when Tunnel is not configured
 * (TUNNEL_BASE_URL not set).
 */

import type { TunnelClient } from "../../tunnel/client.js";

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
