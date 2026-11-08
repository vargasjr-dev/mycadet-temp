import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import type { RouteDefinition } from "./types.js";

export async function handleDesktopSetup(req: Request): Promise<Response> {
  const config = getConfig();
  return proxyForwardToResponse(req, {
    baseUrl: config.assistantRuntimeBaseUrl,
    path: "/v1/desktop/setup",
    timeoutMs: config.runtimeTimeoutMs,
    fetchImpl,
  });
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/desktop/setup",
    method: "get",
    aliases: ["post"],
    scoped: true,
    auth: "edge-guardian",
    handler: (req) => handleDesktopSetup(req),
  },
];
