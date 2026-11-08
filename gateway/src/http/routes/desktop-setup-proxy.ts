import { proxyForwardToResponse } from "@mycadet/assistant-client";

import type { GatewayConfig } from "../../config.js";
import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import type { RouteDefinition } from "./types.js";

export function createDesktopSetupProxyHandler(config: GatewayConfig) {
  return (req: Request): Promise<Response> =>
    proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: "/v1/desktop/setup",
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
}

let routeProxyImpl: ReturnType<typeof createDesktopSetupProxyHandler> | undefined;


/** Built on first request — module import stays side-effect-free. */
function routeProxy(): ReturnType<typeof createDesktopSetupProxyHandler> {
  return (routeProxyImpl ??= createDesktopSetupProxyHandler(getConfig()));
}


export const ROUTES: RouteDefinition[] = [
  {
    path: "/desktop/setup",
    method: "get",
    aliases: ["post"],
    scoped: true,
    auth: "edge-guardian",
    handler: (req) => routeProxy()(req),
  },
];
