/**
 * Integration status route declarations (dispatch-only — never published in
 * the spec). Reports the config-file values the gateway owns; the config
 * cache is injected at server startup.
 */

import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

const configFile = lazyRef<ConfigFileCache>(
  "integrations status routes used before initialization",
);

export function initIntegrationsStatusRoutes(cache: ConfigFileCache): void {
  configFile.set(cache);
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/integrations/status",
    method: "get",
    auth: "edge",
    handler: () =>
      Response.json({
        email: {
          address: configFile.get().getString("email", "address") ?? null,
        },
      }),
  },
  {
    path: /^\/assistants\/([^/]+)\/integrations\/status\/$/,
    method: "get",
    auth: "edge",
    handler: () =>
      Response.json({
        email: {
          address: configFile.get().getString("email", "address") ?? null,
        },
      }),
  },
];
