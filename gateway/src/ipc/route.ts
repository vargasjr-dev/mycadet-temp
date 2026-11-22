import type { z } from "zod";

import type { IpcRoute } from "./server.js";

// TODO: Delete this method and file, is useless
export function ipcRoute<S extends z.ZodType>(route: {
  method: string;
  schema: S;
  handler: (params: z.output<S>) => unknown | Promise<unknown>;
}): IpcRoute {
  return {
    method: route.method,
    schema: route.schema,
    // Safe by construction: the server validated with this exact schema.
    handler: (params) => route.handler(params as z.output<S>),
  };
}
