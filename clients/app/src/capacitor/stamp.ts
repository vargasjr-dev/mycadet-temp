import { SEEDS } from "@mycadet/environments/seeds";
import {
  InjectedConfigSchema,
  type InjectedConfig,
} from "@app/lib/injected-config";
import { resolveLocalServerUrl } from "./local-server";

/**
 * The build-time config the mobile shells bake in: `build:capacitor` stamps
 * it into `dist/capacitor/index.html` as `window.__CADET_CONFIG__`. It IS
 * the shared injected-config shape — the app shell boots from these assets
 * through the same `main.tsx` entry every other host serves, and reads the
 * stamp back through the same `readInjectedConfig()`. Every branch stamps
 * `cloudUrl`: the webview origin serves only baked assets (no `/v1`
 * router), so every same-origin `/v1` request is resolved by the shell's
 * native scheme handler against this base — same-origin would otherwise
 * request `capacitor://localhost/v1/...` and get the SPA's index HTML back.
 *
 * Cloud environments stamp the WEB origin, not the cloud-api origin: the
 * edge routes `/v1` at the origin every web surface boots on, and the
 * account session lives there too — the same origin `webUrl` encodes for
 * the pair flow.
 *
 * The local stamp resolves the RUNNING cadet's control plane from the
 * lockfile (see `resolveLocalServerUrl`): the tunnel URL when one is up,
 * else the app server edge's loopback port — reachable from the simulator
 * only, since a device's `127.0.0.1` is the phone itself. Unresolved builds
 * keep the seed's dev-stack default.
 *
 * Otherwise resolution mirrors the native `server.url` bake this
 * replaces: the release workflows set `CADET_ENVIRONMENT`; `CADET_SERVER_URL` overrides with an
 * https origin for self-hosted assistants; unset means the local cadet.
 */
export function capacitorInjectedConfig(): InjectedConfig {
  const override = process.env.CADET_SERVER_URL?.trim();
  if (!override) {
    const environment = process.env.CADET_ENVIRONMENT ?? "local";
    if (environment === "local") {
      // The local backend is a full control plane — the web dev server
      // proxies /v1 at it — so the simulator reaches the same stack every
      // other local surface uses.
      return InjectedConfigSchema.parse({
        remote: "local",
        cloudUrl: resolveLocalServerUrl() ?? SEEDS.local.cloudUrl,
      });
    }
    const seed = SEEDS[environment] ?? SEEDS.dev;
    return InjectedConfigSchema.parse({
      remote: "cloud",
      cloudUrl: seed.webUrl,
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
