import { z } from "zod";

import { RemoteSchema } from "@mycadet/local-mode/contract";

/**
 * The runtime config a shell injects (`(window as Window & { __CADET_CONFIG__?: unknown }).__CADET_CONFIG__`). This schema
 * is the single shape: readers parse the window through it instead of
 * re-declaring per-file object types.
 *
 * The URL fields are distinct origins in the topology, not synonyms:
 * `cloudUrl` is the cloud backend base — the account session, auth
 * endpoints, and the cloud-hosted assistant list. It is never the API base
 * for a local assistant: the shell resolves assistants same-origin, and the
 * serving origin routes `/v1` to the right control plane (the app server
 * proxies it to the local gateway; the desktop protocol forwards it; the
 * cloud takeover proxies it). The native boot bundle is the one host with
 * no `/v1` router at its origin, so it resolves assistants against
 * `cloudUrl` directly. `hubUrl` is the cloud hub SPA the
 * pairing/settings pages link back to. The platform login base is
 * deliberately absent: the loopback handoff reads it from the build's
 * environment seed (see startLoopbackAuth), keeping this config to the
 * origins a served bundle can't infer.
 */
export const InjectedConfigSchema = z.object({
  /** Nothing injected (SSR) or an unparseable config means the local cadet. */
  remote: RemoteSchema.default("local"),
  /** Cloud backend base (account session, auth, cloud-hosted assistants). */
  cloudUrl: z.string().optional(),
  /** Device id stamped by the Electron host (device management). */
  deviceId: z.string().optional(),
  /** Version of the shell bundle serving this page (stamped by the host). */
  version: z.string().optional(),
  /** Serving assistant's id (remote-web ingress configs only). */
  assistantId: z.string().optional(),
  /** Serving assistant's display name (remote-web ingress configs only). */
  assistantName: z.string().optional(),
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
  const parsed = InjectedConfigSchema.safeParse(
    (window as Window & { __CADET_CONFIG__?: unknown }).__CADET_CONFIG__,
  );
  return parsed.success ? parsed.data : undefined;
}
