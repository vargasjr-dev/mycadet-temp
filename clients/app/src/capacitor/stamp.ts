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
 * keep the seed's dev-stack default — the warn below makes that fallback
 * loud, since the commonest cause is building before the stack is up.
 *
 * Otherwise resolution mirrors the native `server.url` bake this replaces:
 * the release workflows set `CADET_ENVIRONMENT`; unset means the local
 * cadet. That default is pinned here rather than only read, because the
 * lockfile read underneath resolves the environment the same way
 * (`CADET_ENVIRONMENT` → persisted default → production) — without the pin
 * a bare build resolves "production", reads the production config dir, and
 * never sees the local stack's records.
 */
export function capacitorInjectedConfig(): InjectedConfig {
  process.env.CADET_ENVIRONMENT ??= "local";
  const environment = process.env.CADET_ENVIRONMENT;
  if (environment === "local") {
    // The local backend is a full control plane — the web dev server
    // proxies /v1 at it — so the simulator reaches the same stack every
    // other local surface uses.
    const resolved = resolveLocalServerUrl();
    if (!resolved) {
      console.warn(
        `[capacitor] no local server resolved from the lockfile (no tunnel record, no app edge port) — the stamp falls back to ${SEEDS.local.cloudUrl}. Start \`cadet-local app start\` (or \`cadet-local tunnel start\` for a device build) before building so the shell dials the real stack.`,
      );
    }
    return InjectedConfigSchema.parse({
      remote: "local",
      cloudUrl: resolved ?? SEEDS.local.cloudUrl,
    });
  }
  const seed = SEEDS[environment] ?? SEEDS.dev;
  return InjectedConfigSchema.parse({
    remote: "cloud",
    cloudUrl: seed.webUrl,
  });
}

/**
 * The inline script tag carrying the config. Injected before `</head>`,
 * ahead of the deferred module bundle, so the config exists before any
 * reader runs. The payload escapes `<` so a hostile config value can't close
 * the tag and break out (`</script>` becomes `\u003c/script>`) — the same
 * mitigation the CLI's `buildRemoteWebIndexHtml` applies to its own stamps.
 */
export function injectedConfigScript(): string {
  const config = capacitorInjectedConfig();
  return `<script>window.__CADET_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c")}</script>`;
}
