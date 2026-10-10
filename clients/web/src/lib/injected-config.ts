import { z } from "zod";

/** Where the cadet comes from — the same values `cadet hatch --remote` records. */
export type Remote = "local" | "docker" | "custom" | "cloud";

/**
 * The runtime config a shell injects (`window.__CADET_CONFIG__`). This schema
 * is the single shape: readers parse the window through it instead of
 * re-declaring per-file object types.
 */
export const InjectedConfigSchema = z.object({
  disablePlatform: z.boolean().optional(),
  remote: z.enum(["local", "docker", "custom", "cloud"]).optional(),
  platformUrl: z.string().optional(),
  /** Serving assistant's display name (remote-web ingress configs only). */
  assistantName: z.string().optional(),
  /** Serving assistant's id (remote-web ingress configs only). */
  assistantId: z.string().optional(),
  /** Cloud web SPA base for this build's environment (remote-web ingress configs only). */
  hubUrl: z.string().optional(),
});

export type InjectedConfig = z.infer<typeof InjectedConfigSchema>;

/**
 * The parsed injected config, with the remote defaulted: nothing injected
 * (SSR) or a config that doesn't parse means the local cadet.
 */
export function readInjectedConfig(): InjectedConfig & { remote: Remote } {
  if (typeof window === "undefined") {
    return { remote: "local" };
  }
  const parsed = InjectedConfigSchema.safeParse(window.__CADET_CONFIG__);
  return parsed.success
    ? { remote: "local", ...parsed.data }
    : { remote: "local" };
}
