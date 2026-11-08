/**
 * Integration status route declarations (dispatch-only — never published in
 * the spec). Reports the config-file values the gateway owns; the config
 * file cache is read at request time.
 */

import { getConfigFileCache } from "../../config-file-cache.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [
  {
    // The optional `assistants/{id}/` prefix keeps the assistant-flavored
    // spelling alive without a second declaration; the `/assistant` variants
    // are the legacy prefixes long-lived clients still dial (the flat static
    // matcher accepted them before this route grew the optional prefix).
    path: /^\/(?:assistant\/|assistants\/[^/]+\/)?integrations\/status\/?$/,
    method: "get",
    auth: "edge",
    handler: () =>
      Response.json({
        email: {
          address:
            getConfigFileCache().getString("email", "address") ?? null,
        },
      }),
  },
];
