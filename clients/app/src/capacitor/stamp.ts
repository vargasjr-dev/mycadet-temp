import { SEEDS } from "@mycadet/environments/seeds";
import {
  InjectedConfigSchema,
  type InjectedConfig,
} from "@app/lib/injected-config";

/**
 * The build-time config the mobile shells bake in: `build:capacitor` stamps
 * it into `dist/capacitor/index.html` as `window.__CADET_CONFIG__`. It IS
 * the shared injected-config shape — the app shell boots from these assets
 * through the same `main.tsx` entry every other host serves, and reads the
 * stamp back through the same `readInjectedConfig()`. Every branch stamps
 * `cloudUrl`: the webview origin serves only baked assets (no `/v1`
 * router), so the shell and the chooser resolve assistants against the
 * environment's control plane directly — same-origin would request
 * `capacitor://localhost/v1/...` and get the SPA's index HTML back.
 *
 * Resolution mirrors the native `server.url` bake this replaces: the release
 * workflows set `CADET_ENVIRONMENT`; `CADET_SERVER_URL` overrides with an
 * https origin for self-hosted assistants; unset means the local cadet.
 */
export function capacitorInjectedConfig(env: {
  CADET_ENVIRONMENT?: string;
  CADET_SERVER_URL?: string;
}): InjectedConfig {
  const override = env.CADET_SERVER_URL?.trim();
  if (!override) {
    const environment = env.CADET_ENVIRONMENT ?? "local";
    if (environment === "local") {
      // The local backend is a full control plane — the web dev server
      // proxies /v1 at it — so the simulator reaches the same stack every
      // other local surface uses.
      return InjectedConfigSchema.parse({
        remote: "local",
        cloudUrl: SEEDS.local.cloudUrl,
      });
    }
    const seed = SEEDS[environment] ?? SEEDS.dev;
    return InjectedConfigSchema.parse({
      remote: "cloud",
      cloudUrl: seed.cloudUrl,
    });
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

  return InjectedConfigSchema.parse({ remote: "custom", cloudUrl: override });
}

/**
 * The inline script tag carrying the config. Injected before `</head>`,
 * ahead of the deferred module bundle, so the config exists before any
 * reader runs. The payload escapes `<` so a hostile config value can't close
 * the tag and break out (`</script>` becomes `\u003c/script>`) — the same
 * mitigation the CLI's `buildRemoteWebIndexHtml` applies to its own stamps.
 */
export function injectedConfigScript(config: InjectedConfig): string {
  return `<script>window.__CADET_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c")}</script>`;
}
