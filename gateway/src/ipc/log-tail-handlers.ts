/**
 * IPC route definitions for gateway log reads.
 *
 * Exposes gateway-owned logs to the assistant over the local IPC socket
 * without requiring the assistant to mint gateway-audience bearer tokens.
 */

import { GatewayLogsTailIpcParamsSchema } from "@mycadet/gateway-client/gateway-ipc-contracts";

import { tailGatewayLogs } from "../http/routes/log-tail.js";
import type { IpcRoute } from "./server.js";

export const logTailRoutes: IpcRoute[] = [
  {
    method: "gateway_logs_tail",
    schema: GatewayLogsTailIpcParamsSchema,
    handler: (params?: Record<string, unknown>) =>
      tailGatewayLogs(GatewayLogsTailIpcParamsSchema.parse(params)),
  },
];
