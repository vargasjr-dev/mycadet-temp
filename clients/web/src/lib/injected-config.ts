import { z } from "zod";

import { RemoteSchema } from "@mycadet/local-mode/contract";

/**
 * The runtime config a shell injects (`window.__CADET_CONFIG__`). This schema
 * is the single shape: readers parse the window through it instead of
 * re-declaring per-file object types.
 *
 * The URL fields are distinct origins in the topology, not synonyms:
 * `cloudUrl` is the cloud API base and `hubUrl` the cloud hub SPA the
 * pairing/settings pages link back to. The platform login base is
 * deliberately absent: the loopback handoff reads it from the build's
 * environment seed (see startLoopbackAuth), keeping this config to the
 * origins a served bundle can't infer.
 */
export const InjectedConfigSchema = z.object({
  /** Nothing injected (SSR) or an unparseable config means the local cadet. */
  remote: RemoteSchema.default("local"),
  /** Cloud API base (auth endpoints + assistant API). */
  cloudUrl: z.string().optional(),
  /** Device id stamped by the Electron host (device management). */
  deviceId: z.string().optional(),
  /** Version of the shell bundle serving this page (stamped by the host). */
  version: z.string().optional(),
  /** Serving assistant's id, stamped by every host that fronts one assistant. */
  assistantId: z.string().optional(),
  /** Serving assistant's display name, stamped by every host that fronts one assistant. */
  assistantName: z.string().optional(),
  /**
   * The serving assistant's cloud kind (the lockfile entry's `cloud` value),
   * so the renderer can classify the served assistant (local vs a paired
   * connect import) without reading the host's lockfile. Degrades to
   * `undefined` (the plain on-machine spelling) when absent or unknown, so
   * a stamp from a newer host can never invalidate the whole config.
   */
  assistantCloud: RemoteSchema.optional().catch(undefined),
  /** Cloud web SPA base for this build's environment (remote-web ingress configs only). */
  hubUrl: z.string().optional(),
});

export type InjectedConfig = z.infer<typeof InjectedConfigSchema>;

/**
 * The parsed injected config, or `undefined` when nothing usable was
 * injected (SSR, a host that injects nothing, or a config that doesn't
 * parse). The `remote` default lives in the schema, so any returned config
 * always carries one.
 */
export function readInjectedConfig(): InjectedConfig | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const parsed = InjectedConfigSchema.safeParse(window.__CADET_CONFIG__);
  return parsed.success ? parsed.data : undefined;
}
