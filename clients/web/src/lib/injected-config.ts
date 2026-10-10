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

/** The parsed injected config; undefined when nothing was injected (SSR) or it doesn't parse. */
export function readInjectedConfig(): InjectedConfig | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const parsed = InjectedConfigSchema.safeParse(window.__CADET_CONFIG__);
  return parsed.success ? parsed.data : undefined;
}

/** The injected config with the remote defaulted: no injection means the local cadet. */
export function getInjectedConfig(): InjectedConfig & { remote: Remote } {
  return { remote: "local", ...readInjectedConfig() };
}
