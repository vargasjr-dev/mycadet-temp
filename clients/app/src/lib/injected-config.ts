import { z } from "zod";

import { RemoteSchema } from "@mycadet/local-mode/contract";

/**
 * The runtime config a shell injects (`(window as Window & { __CADET_CONFIG__?: unknown }).__CADET_CONFIG__`). This schema
 * is the single shape: readers parse the window through it instead of
 * re-declaring per-file object types.
 */
export const InjectedConfigSchema = z.object({
  /** Nothing injected (SSR) or an unparseable config means the local cadet. */
  remote: RemoteSchema.default("local"),
  /** The single origin for API, auth, and the assistant mount (see above). */
  baseUrl: z.string().optional(),
  /** Device id stamped by the Electron host (device management). */
  deviceId: z.string().optional(),
  /** Version of the shell bundle serving this page (stamped by the host). */
  version: z.string().optional(),
  /** Serving assistant's id (remote-web ingress configs only). */
  assistantId: z.string().optional(),
  /** Serving assistant's display name (remote-web ingress configs only). */
  assistantName: z.string().optional(),
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
  const parsed = InjectedConfigSchema.safeParse(
    (window as Window & { __CADET_CONFIG__?: unknown }).__CADET_CONFIG__,
  );
  return parsed.success ? parsed.data : undefined;
}
