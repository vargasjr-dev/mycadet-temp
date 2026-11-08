/** Integration status (dispatch-only, never in the spec). */

import { getConfigFileCache } from "../../config-file-cache.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [
  {
    path: /^\/(?:assistant\/|assistants\/[^/]+\/)?integrations\/status\/?$/,
    method: "get",
    auth: "edge",
    handler: () =>
      Response.json({
        email: {
          address: getConfigFileCache().getString("email", "address") ?? null,
        },
      }),
  },
];
