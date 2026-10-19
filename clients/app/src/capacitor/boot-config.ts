import { cloudAssistantHubUrl } from "@mycadet/environments/seeds";
import { z } from "zod";

/**
 * The runtime config the baked Capacitor boot bundle ships with, stamped
 * into `dist/capacitor/index.html` as `window.__CADET_CONFIG__` at build
 * time (`bun run build:capacitor`). The boot bundle reads the stamp back
 * through `readCapacitorBootConfig()` — this schema owns it, not the shared
 * `InjectedConfigSchema`, so the handoff URL never joins the shared surface's
 * origin families.
 *
 * The mobile shells boot on this baked bundle (the `webDir` in
 * `capacitor.config.base.ts`) so the initial Cadet screens render from
 * local assets with zero network, then hand off to the environment's
 * session-gated assistant entry — the exact URL `server.url` used to be
 * baked into the native config by `cap sync`. Login, session cookies, and
 * the Capacitor plugin bridge all keep living on that entry origin, so the
 * handoff changes none of that; it only moves where the first paint comes
 * from.
 */
export const CapacitorBootConfigSchema = z.object({
  /** Where the cadet comes from — the seeds' own env, or the override. */
  remote: z.enum(["local", "custom", "cloud"]),
  /** Session-gated assistant entry the boot shell hands off to. */
  handoffUrl: z.string(),
});

export type CapacitorBootConfig = z.infer<typeof CapacitorBootConfigSchema>;

/**
 * The parsed boot stamp, or `undefined` when the bundle runs somewhere that
 * isn't its baked home: SSR, a host that injects nothing, or a stale sync
 * whose stamp no longer parses (both fields are required, so a competing
 * shape — like the local-mode shim's `{ webUrl, cloudUrl }` — reads as
 * absent).
 */
export function readCapacitorBootConfig(): CapacitorBootConfig | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const parsed = CapacitorBootConfigSchema.safeParse(
    (window as Window & { __CADET_CONFIG__?: unknown }).__CADET_CONFIG__,
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Resolve the boot bundle's handoff from the build environment. Mirrors the
 * server-url resolution the base Capacitor config used to own: the release
 * workflows set `CADET_ENVIRONMENT`; `CADET_SERVER_URL` overrides with an
 * https origin for self-hosted assistants; unset means the local cadet.
 */
export function capacitorBootConfig(env: {
  CADET_ENVIRONMENT?: string;
  CADET_SERVER_URL?: string;
}): CapacitorBootConfig {
  const override = env.CADET_SERVER_URL?.trim();
  if (!override) {
    const environment = env.CADET_ENVIRONMENT ?? "local";
    return {
      remote: environment === "local" ? "local" : "cloud",
      handoffUrl: cloudAssistantHubUrl(environment),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(
      `CADET_SERVER_URL is not a valid URL: ${JSON.stringify(override)}`,
    );
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `CADET_SERVER_URL must use https: (got ${JSON.stringify(override)}); native builds require valid TLS.`,
    );
  }

  return { remote: "custom", handoffUrl: override };
}

/**
 * The inline script tag carrying the boot config. Injected before
 * `</head>`, ahead of the deferred module bundle, so the config exists
 * before any reader runs. The payload escapes `<` so a hostile handoff URL
 * can't close the tag and break out (`</script>` becomes
 * `\u003c/script\u003e`) — the same mitigation the CLI's
 * `buildRemoteWebIndexHtml` applies to its own stamps.
 */
export function bootConfigScript(config: CapacitorBootConfig): string {
  return `<script>window.__CADET_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c")}</script>`;
}
