import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { GATEWAY_SERVICE_IDENTITY } from "@mycadet/assistant-client";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";

export function createDesktopSetupProxyHandler(config: GatewayConfig) {
  return (req: Request): Promise<Response> =>
    proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: "/v1/desktop/setup",
      identity: GATEWAY_SERVICE_IDENTITY,
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
}
