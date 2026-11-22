/**
 * IPC route definitions for Tunnel status.
 *
 * Exports a single `get_tunnel_status` IPC route whose handler resolves the
 * process-wide TunnelClient at call time — the `getConfig()` pattern: the
 * client is torn down and rebuilt as the tunnel comes and goes, so a
 * captured reference would answer for a client that is no longer the live
 * one. Returns disconnected/null when no client is configured (e.g.
 * TUNNEL_BASE_URL not set).
 */

import type { TunnelStatusIpcResponse } from "@mycadet/gateway-client/gateway-ipc-contracts";

import { getTunnelClient } from "../tunnel/client.js";
import type { IpcRoute } from "./server.js";

export const tunnelRoutes: IpcRoute[] = [
  {
    method: "get_tunnel_status",
    handler: (): TunnelStatusIpcResponse => {
      const tunnelClient = getTunnelClient();
      if (!tunnelClient) {
        return { connected: false, publicUrl: null };
      }
      return tunnelClient.getStatus();
    },
  },
];
