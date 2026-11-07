import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getAssistantBaseUrl } from "../../config.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";

export function createDesktopSetupProxyHandler(config: GatewayConfig) {
  return (req: Request): Promise<Response> =>
    proxyForwardToResponse(req, {
      baseUrl: getAssistantBaseUrl(),
      path: "/v1/desktop/setup",
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
}
