/**
 * IPC route definitions for Tunnel tunnel status.
 *
 * Exports a factory that takes the optional TunnelClient and returns
 * a single `get_tunnel_status` IPC route. Returns disconnected/null when no
 * client is configured (e.g. TUNNEL_BASE_URL not set).
 */

import type { TunnelStatusIpcResponse } from "@mycadet/gateway-client/gateway-ipc-contracts";

import type { TunnelClient } from "../tunnel/client.js";
import type { IpcRoute } from "./server.js";

export function createTunnelRoutes(
  tunnelClient: TunnelClient | undefined,
): IpcRoute[] {
  return [
    {
      method: "get_tunnel_status",
      handler: (): TunnelStatusIpcResponse => {
        if (!tunnelClient) {
          return { connected: false, publicUrl: null };
        }
        return tunnelClient.getStatus();
      },
    },
  ];
}
