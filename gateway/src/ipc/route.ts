import type { z } from "zod";

import type { IpcRoute } from "./server.js";

/**
 * Define a schema-validated route whose handler receives the parsed params
 * already typed.
 *
 * The server validates `req.params` against `schema` and passes the parsed
 * value to the handler, but {@link IpcMethodHandler} widens it back to
 * `Record<string, unknown>`; recovering the type at each handler means either
 * a cast or a second `schema.parse()` of data the server just validated. This
 * helper does that narrowing once, where the guarantee is made.
 *
 * This lives apart from the server so the handler modules can import it
 * without a runtime cycle: routes.ts aggregates the handlers, the server
 * imports routes.ts, and the handlers only need this helper.
 *
 * New schema-validated routes use this. Older routes still parse their params
 * a second time inside the handler, which is redundant but harmless.
 */
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
