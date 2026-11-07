import { proxyForwardToResponse } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

export function createDesktopSetupProxyHandler(config: GatewayConfig) {
  return (req: Request): Promise<Response> =>
    proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: "/v1/desktop/setup",
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
}

const routeProxy = lazyRef<ReturnType<typeof createDesktopSetupProxyHandler>>(
  "Desktop setup proxy used before initialization",
);

export function initDesktopSetupRoutes(config: GatewayConfig): void {
  routeProxy.set(createDesktopSetupProxyHandler(config));
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/desktop/setup",
    method: "get",
    aliases: ["post"],
    scoped: true,
    auth: "edge-guardian",
    handler: (req) => routeProxy.get()(req),
  },
];
